#!/usr/bin/env python3
"""Build a Mac-only outer bundle from a clean pinned commit, entirely offline.

Maintainer tool: runs local checks, then validates the exact archive and ZIP.
It does not connect to a server or imply that native/production checks ran.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

REPO = Path(__file__).resolve().parents[3]
MANUAL = Path('pasofi-backend/local-tools/manual deployment')
SHELLS = ('Start_PasoFi.command', 'release-deploy.command', 'release-deploy.sh', 'hotspot-readiness.command', 'mac-python.sh')
HELPERS = ('pasofi-auto.py', 'release-deploy.py', 'deployment-backup.py', 'deployment-restore.py', 'deployment-postcheck.py', 'hotspot-readiness.py')
SOURCE_FILES = {name: MANUAL / name for name in (*SHELLS, *HELPERS, 'mac-connection.json', 'deployment-target.json',
                                                'READ_ME_FIRST.txt', 'MAC_DEPLOY.md', 'HOTSPOT_READINESS.md')}
SOURCE_FILES.update({
    'ROUTER_FLEET.md': Path('pasofi-backend/infra/production/ROUTER_FLEET.md'),
    'CASH_HOTSPOT_LAUNCH.md': Path('pasofi-backend/docs/CASH_HOTSPOT_LAUNCH.md'),
    'TWO_SITE_HOTSPOT_ACCEPTANCE.md': Path('pasofi-backend/docs/TWO_SITE_HOTSPOT_ACCEPTANCE.md'),
})
GENERATED = {'release.json', 'source.tar.gz', 'RELEASE_EVIDENCE.json', 'SHA256SUMS.txt', 'PasoFi_Mac_Deployment_Guide.md'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def command(argv):
    result = subprocess.run(argv, cwd=REPO, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, check=False, timeout=300)
    require(result.returncode == 0, 'A local package check failed: ' + ' '.join(argv[:3]))
    return result.stdout + result.stderr


def git(*args):
    return command(['git', *args]).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_ci(path, commit, tree):
    if path is None:
        return {'status': 'not_recorded', 'checks': []}
    data = json.loads(path.read_text())
    require(type(data) is dict and data.get('source_tree') == tree and type(data.get('checks')) is list and data['checks'],
            'CI evidence must identify this exact source tree and completed checks.')
    checks = []
    for item in data['checks']:
        require(type(item) is dict and set(item) == {'name', 'conclusion', 'url', 'head_sha'}
                and type(item['name']) is str and 1 <= len(item['name']) <= 100 and item['conclusion'] == 'success'
                and type(item['url']) is str and re.fullmatch(r'https://github\.com/DruHustle/pasofi/actions/runs/[0-9]+(?:/job/[0-9]+)?', item['url'])
                and type(item['head_sha']) is str and re.fullmatch(r'[0-9a-f]{40}', item['head_sha']),
                'CI evidence contains an unsupported or unsuccessful check.')
        checks.append(item)
    require({'Verify PasoFi', 'Verify Mac deployment launcher'} <= {item['name'] for item in checks},
            'Record both the complete workflow and native Mac job for CI qualification.')
    return {'status': 'passed_for_source_tree', 'source_tree': tree, 'checks': checks}


def build(output, ci_path=None):
    require(sys.version_info >= (3, 9), 'The package checks and shipped launcher require Python 3.9 or newer.')
    require(not git('status', '--porcelain'), 'Commit the reviewed candidate before building its pinned package.')
    commit, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
    require(re.fullmatch(r'[0-9a-f]{40}', commit) and re.fullmatch(r'[0-9a-f]{40}', tree), 'Git source identity is invalid.')
    output = output.resolve()
    require(output != REPO and REPO not in output.parents and not output.exists(), 'Use a new output directory outside the source checkout.')
    node_version = command(['node', '--version']).strip()
    require(node_version == 'v24.22.1', 'Use the repository-pinned Node 24.22.1 for package qualification.')
    test_output = command([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', str(MANUAL), '-p', 'test_*.py', '-q'])
    count = re.search(r'Ran ([0-9]+) tests? in ', test_output)
    require(count is not None and re.search(r'^OK$', test_output, re.M), 'All package tests must pass without skipped tests.')
    for shell in SHELLS:
        command(['/bin/bash', '-n', str(MANUAL / shell)])
    fleet = command(['node', '--test', '--test-reporter=tap', 'pasofi-backend/infra/production/router-fleet-config.test.mjs'])
    fleet_count = re.search(r'# tests ([0-9]+)', fleet)
    require(fleet_count is not None and re.search(r'# fail 0\b', fleet) and re.search(r'# skipped 0\b', fleet),
            'Fleet configuration checks did not complete without failures or skips.')
    require(not git('status', '--porcelain'), 'Source changed during package qualification.')
    ci = read_ci(ci_path, commit, tree)
    output.mkdir(parents=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='pasofi-package-', dir=output) as temporary:
        work = Path(temporary)
        stage = work / 'PasoFi_Mac_Deployment_Pack'
        stage.mkdir()
        archive = stage / 'source.tar.gz'
        command(['git', 'archive', '--format=tar.gz', '--prefix=pasofi/', '-o', str(archive), commit])
        manifest = {'schema': 1, 'commit': commit, 'archive_sha256': digest(archive),
                    'services': ['identity', 'prepaid-access', 'network', 'notification', 'assistant', 'web'],
                    'migrations': ['identity', 'prepaid-access', 'network', 'notification', 'assistant']}
        (stage / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
        spec = importlib.util.spec_from_file_location('packaging_release_engine', REPO / MANUAL / 'release-deploy.py')
        engine = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(engine)
        require(engine.load_manifest(stage / 'release.json', archive) == manifest, 'Manifest integrity check failed.')
        extracted = engine.extract_source(archive, work / 'extracted', commit)
        for destination, relative in SOURCE_FILES.items():
            source = extracted / relative
            require(source.is_file() and not source.is_symlink() and source.stat().st_size <= 1024 * 1024,
                    'An allowed package source is missing or not a bounded regular file.')
            shutil.copyfile(source, stage / destination)
            (stage / destination).chmod(0o755 if destination in SHELLS else 0o644)
        evidence = {
            'schema': 2, 'prepared_at_utc': datetime.now(timezone.utc).isoformat(),
            'source_commit': commit, 'source_tree': tree, 'source_archive_sha256': manifest['archive_sha256'],
            'entry_point': 'Start_PasoFi.command', 'connection_profile': 'mac-connection.json',
            'qualification': 'prepared_with_recorded_ci' if ci['status'] != 'not_recorded' else 'prepared_with_local_checks_ci_not_recorded',
            'local_checks': {'manual_deployment_tests_passed': int(count.group(1)), 'manual_deployment_tests_skipped': 0,
                             'fleet_configuration_tests_passed': int(fleet_count.group(1)), 'node_version': node_version,
                             'launcher_shell_syntax': 'passed', 'actual_node_diagnostics': 'passed',
                             'actual_config_checker': 'passed', 'platform': sys.platform},
            'ci': ci, 'native_finder_launch_tested': False, 'production_deployment_performed': False,
            'production_backup_restore_performed': False, 'off_host_recovery_tested': False,
            'physical_customer_acceptance_performed': False, 'real_customer_messages_sent': False,
            'real_customer_transactions_created': False,
            'scope': 'Application deployment and automatic postchecks; preserves existing gates, overlays and protected containers.',
            'remaining_acceptance': 'Actual server execution and physical cash/hotspot/RADIUS/quota/reconnect acceptance remain required.',
        }
        (stage / 'RELEASE_EVIDENCE.json').write_text(json.dumps(evidence, indent=2) + '\n')
        guide = (stage / 'MAC_DEPLOY.md').read_text() + '\n## This prepared package\n\n' + \
            '- Pinned source: `' + commit + '`.\n- Archive SHA-256: `' + manifest['archive_sha256'] + '`.\n' + \
            '- Local manual-deployment checks: **' + count.group(1) + ' passed**, none skipped.\n' + \
            '- CI qualification: `' + ci['status'] + '`; see the included evidence for exact scope and links.\n'
        (stage / 'PasoFi_Mac_Deployment_Guide.md').write_text(guide)
        files = sorted(path for path in stage.iterdir() if path.name != 'SHA256SUMS.txt')
        (stage / 'SHA256SUMS.txt').write_text(''.join(digest(path) + '  ' + path.name + '\n' for path in files))
        require({path.name for path in stage.iterdir()} == set(SOURCE_FILES) | GENERATED, 'The package contains an unexpected file.')
        destination = output / 'PasoFi_Mac_Deployment_Pack.zip'
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
            for path in sorted(stage.iterdir()):
                package.write(path, stage.name + '/' + path.name)
        with zipfile.ZipFile(destination) as package:
            require(package.testzip() is None, 'ZIP CRC verification failed.')
            require(len(package.infolist()) == len(SOURCE_FILES) + len(GENERATED), 'ZIP file count differs from its allowlist.')
            for name in SHELLS:
                require((package.getinfo(stage.name + '/' + name).external_attr >> 16) & 0o777 == 0o755,
                        'A Mac entry point lost its executable mode.')
            for line in (stage / 'SHA256SUMS.txt').read_text().splitlines():
                expected, name = line.split('  ', 1)
                require(hashlib.sha256(package.read(stage.name + '/' + name)).hexdigest() == expected, 'An archived file checksum differs.')
        for filename in ('PasoFi_Mac_Deployment_Guide.md', 'RELEASE_EVIDENCE.json'):
            shutil.copyfile(stage / filename, output / filename)
    summary = {'source_commit': commit, 'source_tree': tree, 'zip_path': str(destination), 'zip_sha256': digest(destination),
               'zip_bytes': destination.stat().st_size, 'guide_path': str(output / 'PasoFi_Mac_Deployment_Guide.md'),
               'evidence_path': str(output / 'RELEASE_EVIDENCE.json'), 'qualification': evidence['qualification'],
               'local_checks': evidence['local_checks'], 'archive_and_zip_verification': 'passed'}
    (output / 'PACKAGE_SUMMARY.json').write_text(json.dumps(summary, indent=2) + '\n')
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='New output directory outside the checkout')
    parser.add_argument('--ci-evidence', type=Path, help='Optional recorded successful checks for this exact source tree')
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.output, args.ci_evidence), indent=2))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Package not completed: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
