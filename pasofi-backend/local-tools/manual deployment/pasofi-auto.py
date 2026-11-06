#!/usr/bin/env python3
"""No-input Mac deployment coordinator. Physical hotspot acceptance stays explicit."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
REQUIRED_FILES = ('release-deploy.py', 'release-deploy.sh', 'deployment-backup.py', 'deployment-restore.py', 'deployment-postcheck.py',
                  'hotspot-readiness.py', 'mac-connection.json', 'deployment-target.json', 'release.json', 'source.tar.gz')
CAPABILITY_BOOLEANS = ('demo', 'paymentCheckout', 'vouchers', 'receiptPairing', 'staffSales', 'inventoryAllocation',
                       'salesLocationStatus', 'cashShifts', 'deliverySms', 'networkAccess', 'mobileCookies', 'invoices',
                       'routerFleet', 'routerFleetWrite', 'invoiceEmail', 'invoiceSms')
PENDING_ACCEPTANCE = (
    'Inspect and qualify each physical MikroTik and Mercusys access point.',
    'Qualify private router management, RADIUS accounting and session disconnection on the actual routers.',
    'Run the controlled cash sale, private receipt/PDF, redemption and Wi-Fi connection journey.',
    'Measure quota/expiry cutoff, reconnect, shared balance across both sites, isolation and outage recovery.',
    'Verify staff/site permissions, published bundles, stock, cash shifts and operational alert receipt.',
    'Keep card/mobile-money checkout disabled until its actual provider integration is qualified.',
)
EXPLANATIONS = {
    'ssh_unavailable': 'No configured connection could be used. The report lists the connection result; no SSH settings were changed.',
    'server_identity_unverified': 'The independently retained database record is missing, inaccessible or does not match this server.',
    'installation_unresolved': 'The existing project or complete ordered Compose/environment records could not be established.',
    'package_invalid': 'The package is incomplete, its pinned source does not match, or a configuration file is invalid.',
    'preflight_failed': 'The existing deployment did not pass configuration preflight. No application rollout was requested.',
    'prior_operation_uncertain': 'A previous deployment did not return a confirmed result. Read-only checks were run; automatic reapplication is blocked.',
    'deployment_uncertain': 'The deployment command did not return a confirmed success. Some operations may have completed; inspect the saved server record before retrying.',
    'postcheck_unavailable': 'The post-deployment server checks could not be completed.',
    'postcheck_failed': 'One or more server, migration, queue or scheduled-operation checks need attention.',
    'public_checks_failed': 'One or more public HTTPS/API checks did not return their expected safe response.',
    'already_running': 'Another copy of this package is already running on this Mac.',
    'local_output_unavailable': 'The private local result directory could not be used.',
    'interrupted': 'The operation was interrupted. If deployment had started, its result must be checked before retrying.',
}


class AutomaticError(Exception):
    def __init__(self, code):
        super().__init__(code if code in EXPLANATIONS else 'package_invalid')


def load_module(filename, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path, limit=128 * 1024):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise AutomaticError('package_invalid')
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise AutomaticError('package_invalid')
    return json.loads(raw)


def origin(value):
    if type(value) is not str or len(value) > 260:
        raise AutomaticError('package_invalid')
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https' or parsed.netloc != parsed.hostname or parsed.path or parsed.query or parsed.fragment:
        raise AutomaticError('package_invalid')
    host = parsed.hostname or ''
    if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', host) or host.endswith(('.local', '.localhost')):
        raise AutomaticError('package_invalid')
    return value


def target_configuration(path):
    data = read_json(path, 4096)
    if type(data) is not dict or set(data) != {'schema', 'frontend_origin', 'backend_origin'} or type(data['schema']) is not int or data['schema'] != 1:
        raise AutomaticError('package_invalid')
    frontend, backend = origin(data['frontend_origin']), origin(data['backend_origin'])
    if frontend == backend:
        raise AutomaticError('package_invalid')
    return {'schema': 1, 'frontend_origin': frontend, 'backend_origin': backend}


def private_directory(path):
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise AutomaticError('local_output_unavailable')
    return path


def durable_state_root():
    """Keep control records across copied or freshly extracted packages."""
    path = Path.home()
    for part in ('Library', 'Application Support', 'PasoFi', 'Deployments'):
        path = path / part
        path.mkdir(mode=0o700, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise AutomaticError('local_output_unavailable')
    return private_directory(path)


def write_private(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        if type(value) is str:
            handle.write(value)
        else:
            json.dump(value, handle, indent=2)
            handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    # Persist the marker's directory entry before starting a remote operation.
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def local_lock(directory):
    import fcntl
    descriptor = os.open(directory / 'launcher.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise AutomaticError('local_output_unavailable')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AutomaticError('already_running') from None
        yield
    finally:
        os.close(descriptor)


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_read(url):
    request = urllib.request.Request(url, headers={'Accept': 'application/json, text/html;q=0.9',
                                                   'Cache-Control': 'no-cache', 'User-Agent': 'PasoFi-Deployment-Check/1'})
    opener = urllib.request.build_opener(NoRedirects)
    try:
        response = opener.open(request, timeout=12)
    except urllib.error.HTTPError as response:
        # Expected 401/403/404 responses still require their actual JSON body.
        with response:
            return read_http_response(response)
    with response:
        return read_http_response(response)


def read_http_response(response):
    body = response.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise ValueError()
    return {'status': response.code, 'content_type': response.headers.get('Content-Type', '').split(';', 1)[0].strip().lower(),
            'sets_cookie': response.headers.get('Set-Cookie') is not None, 'body': body}


def public_checks(target, *, require_release=True, fetcher=http_read):
    frontend, backend = target['frontend_origin'], target['backend_origin']
    probes = (
        ('home', frontend + '/', (200,), 'text/html'),
        ('capabilities', frontend + '/api/capabilities', (200,), 'application/json'),
        ('anonymous_customer', frontend + '/api/session', (401,), 'application/json'),
        ('anonymous_staff', frontend + '/api/staff/sites', (401,), 'application/json'),
        ('frontend_internal_denied', frontend + '/api/internal/v1/session', (404,), 'application/json'),
        ('oracle_liveness', backend + '/health/live', (200,), 'application/json'),
        ('oracle_direct_api_denied', backend + '/api/session', (403,), 'application/json'),
        ('oracle_internal_denied', backend + '/internal/v1/session', (404,), 'application/json'),
    )
    result = {'checks': [], 'capabilities': {}, 'passed': False}
    envelopes = {
        'anonymous_customer': {'error': 'not_authenticated'},
        'anonymous_staff': {'error': 'not_authenticated'},
        'frontend_internal_denied': {'error': 'not_found'},
        'oracle_liveness': {'status': 'ok', 'service': 'gateway'},
        'oracle_direct_api_denied': {'error': 'proxy_authentication_required'},
        'oracle_internal_denied': {'error': 'not_found'},
    }
    for name, url, statuses, content_type in probes:
        check = {'name': name, 'status': 'failed'}
        try:
            response = fetcher(url)
            if response['status'] not in statuses or response['content_type'] != content_type:
                raise ValueError()
            if name != 'home' and response['sets_cookie']:
                raise ValueError()
            if content_type == 'application/json':
                data = json.loads(response['body'])
                if type(data) is not dict:
                    raise ValueError()
                if name in envelopes and data != envelopes[name]:
                    raise ValueError()
                if name == 'capabilities':
                    if data.get('demo') is not False or data.get('paymentCheckout') is not False or data.get('paymentMode') != 'disabled':
                        raise ValueError()
                    required = ('staffSales', 'networkAccess', 'vouchers', 'receiptPairing', 'deliverySms')
                    if any(type(data.get(key)) is not bool for key in required):
                        raise ValueError()
                    if require_release and (data.get('salesLocationStatus') is not True or data.get('invoices') is not True):
                        raise ValueError()
                    result['capabilities'] = {key: data[key] for key in CAPABILITY_BOOLEANS if type(data.get(key)) is bool}
                    result['capabilities']['paymentMode'] = 'disabled'
            check['status'] = 'passed'
        except (OSError, ValueError, TypeError, KeyError, urllib.error.URLError, RecursionError):
            pass
        result['checks'].append(check)
    result['passed'] = all(check['status'] == 'passed' for check in result['checks'])
    return result


def migrations_from_archive(engine, manifest, archive):
    result = {}
    with tempfile.TemporaryDirectory(prefix='pasofi-source-check-') as temporary:
        source = engine.extract_source(archive, temporary, manifest['commit'])
        for service in manifest['migrations']:
            directory = source / 'pasofi-backend/services' / (service + '-service') / 'migrations'
            entries = sorted(directory.glob('*.sql'))
            if not entries or len(entries) > 200:
                raise AutomaticError('package_invalid')
            result[service] = {}
            for entry in entries:
                if not re.fullmatch(r'[0-9]{3}_[a-z0-9_]{1,120}\.sql', entry.name) or entry.stat().st_size > 8 * 1024 * 1024:
                    raise AutomaticError('package_invalid')
                result[service][entry.name] = hashlib.sha256(entry.read_bytes()).hexdigest()
    return result


def run_engine(alias, project, *, apply):
    argv = [sys.executable, '-I', '-B', '-S', str(ROOT / 'release-deploy.py'),
            '--manifest', str(ROOT / 'release.json'), '--archive', str(ROOT / 'source.tar.gz'),
            '--host', alias, '--project', project, '--discover-existing']
    if apply:
        argv.append('--apply')
    # Engine progress is intentionally sanitized. Never capture Docker or SSH
    # diagnostics in the shareable report; there is no interactive stdin.
    return subprocess.run(argv, stdin=subprocess.DEVNULL, check=False).returncode


def result_report():
    return {'schema': 1, 'started_at_utc': datetime.now(timezone.utc).isoformat(), 'finished_at_utc': None,
            'release': None, 'selected_alias': None, 'project': None, 'stages': [], 'issues': [],
            'connection': None, 'baseline': None, 'server_postchecks': None, 'public_postchecks': None,
            'application_deployment': 'not_started', 'software_checks_passed': False, 'customer_ready': False,
            'physical_checks': 'not_performed', 'pending_acceptance': list(PENDING_ACCEPTANCE)}


def stage(report, name, status):
    report['stages'].append({'name': name, 'status': status})


def recorded_operation(path, manifest, project, database_id, migrations, postcheck):
    """A previous success binds to this release, project and retained database.

    Keep its original flags for retry comparisons. A different SSH alias may
    legitimately reach the same database, so the alias is not its identity.
    """
    data = read_json(path)
    if (type(data) is not dict or set(data) != {'schema', 'release', 'project', 'database_id', 'baseline_flags'}
            or type(data['schema']) is not int or data['schema'] != 1
            or data['release'] != manifest['commit'] or data['project'] != project or data['database_id'] != database_id):
        raise AutomaticError('prior_operation_uncertain')
    postcheck.validate_inputs(project, manifest['commit'], database_id, migrations, data['baseline_flags'])
    return data['baseline_flags']


def execute(report, directory, *, apply, state_root=None):
    if any(not (ROOT / name).is_file() or (ROOT / name).is_symlink() for name in REQUIRED_FILES):
        raise AutomaticError('package_invalid')
    readiness = load_module('hotspot-readiness.py', 'pasofi_readiness')
    engine = load_module('release-deploy.py', 'pasofi_release')
    postcheck = load_module('deployment-postcheck.py', 'pasofi_postcheck')
    manifest = engine.load_manifest(ROOT / 'release.json', ROOT / 'source.tar.gz')
    # This coordinator covers the complete application release, not partial apps.
    if set(manifest['services']) != set(postcheck.RELEASE_SERVICES) or set(manifest['migrations']) != set(postcheck.APPS):
        raise AutomaticError('package_invalid')
    target = target_configuration(ROOT / 'deployment-target.json')
    migrations = migrations_from_archive(engine, manifest, ROOT / 'source.tar.gz')
    report['release'] = manifest['commit']
    stage(report, 'Package integrity', 'passed')
    print('1/5 — Finding the configured server and reading its existing installation.', flush=True)
    baseline, connection = readiness.automatic_report(readiness.load_profile(ROOT / 'mac-connection.json'),
        progress=lambda alias, status: print('  ' + alias + ': ' + status, flush=True))
    report['connection'], report['baseline'] = connection, baseline
    alias = connection['selected_alias']
    report['selected_alias'], report['project'] = alias, baseline['project']
    if not alias or 'ssh_or_remote_collection_unavailable' in baseline['blockers']:
        raise AutomaticError('ssh_unavailable')
    if not baseline['project'] or not isinstance(baseline['stack'].get('compose_files'), list) or not isinstance(baseline['stack'].get('environment_files'), list):
        raise AutomaticError('installation_unresolved')
    if baseline['database_identity'].get('status') != 'match':
        raise AutomaticError('server_identity_unverified')
    project = baseline['project']
    database_id = baseline['database_identity']['retained_system_identifier']
    stage(report, 'Server and retained installation records', 'passed')
    # Persistent records survive interruption and successful completion alike.
    # Reopening this package cannot silently apply the same release a second time.
    state_key = hashlib.sha256(json.dumps([database_id, project, manifest['commit']], separators=(',', ':')).encode()).hexdigest()
    controls = private_directory((state_root if state_root is not None else durable_state_root()) / state_key)
    marker, completed = controls / 'pending.json', controls / 'completed.json'
    legacy = [directory / (prefix + manifest['commit'] + '.json') for prefix in ('pending-', 'completed-')]
    flags = baseline['flags']
    observed_operation = any(path.exists() or path.is_symlink() for path in (marker, completed, *legacy))
    if completed.exists() or completed.is_symlink():
        try:
            flags = recorded_operation(completed, manifest, project, database_id, migrations, postcheck)
            report['application_deployment'] = 'completed'
            stage(report, 'Deployment', 'previously_completed_checks_only')
            print('This package already completed its deployment. Running read-only checks only.', flush=True)
        except Exception:
            report['application_deployment'] = 'uncertain_previous_operation'
            flags = {service: {key: 'unknown' for key in gates} for service, gates in baseline['flags'].items()}
    elif observed_operation:
        report['application_deployment'] = 'uncertain_previous_operation'
        try:
            flags = recorded_operation(marker, manifest, project, database_id, migrations, postcheck)
        except Exception:
            # Corrupt/legacy markers still block reapplication. Do not pretend
            # that a newly observed flag value was the original baseline.
            flags = {service: {key: 'unknown' for key in gates} for service, gates in baseline['flags'].items()}
    if report['application_deployment'] == 'uncertain_previous_operation':
        report['application_deployment'] = 'uncertain_previous_operation'
        report['issues'].append('prior_operation_uncertain')
        stage(report, 'Deployment', 'not_repeated')
        print('A previous deployment result is uncertain. Running read-only postchecks only.', flush=True)
    elif not observed_operation:
        print('2/5 — Verifying the complete existing configuration and pinned release.', flush=True)
        if run_engine(alias, project, apply=False) != 0:
            stage(report, 'Deployment preflight', 'failed')
            raise AutomaticError('preflight_failed')
        stage(report, 'Deployment preflight', 'passed')
        if apply:
            write_private(marker, {'schema': 1, 'release': manifest['commit'], 'project': project,
                                   'database_id': database_id, 'baseline_flags': flags})
            report['application_deployment'] = 'started'
            print('3/5 — Verifying backup and restore, then building, migrating and deploying.', flush=True)
            try:
                if run_engine(alias, project, apply=True) != 0:
                    raise AutomaticError('deployment_uncertain')
                write_private(completed, {'schema': 1, 'release': manifest['commit'], 'project': project,
                                         'database_id': database_id, 'baseline_flags': flags})
                report['application_deployment'] = 'completed'
                marker.unlink()
                stage(report, 'Backup, restore, migrations and deployment', 'passed')
            except (Exception, KeyboardInterrupt):
                # Even a lost SSH result or interrupt after apply started must
                # continue to observations. Never run a second apply to guess.
                report['application_deployment'] = 'uncertain'
                report['issues'].append('deployment_uncertain')
                stage(report, 'Deployment', 'unconfirmed')
        else:
            report['application_deployment'] = 'preflight_only'
            stage(report, 'Deployment', 'not_requested')
    if report['application_deployment'] == 'preflight_only':
        # The current services are allowed to be older than this package.
        # Readiness and engine preflight inspect them without asserting a rollout.
        stage(report, 'Target-release post-deployment checks', 'not_performed_preflight_only')
    else:
        print('4/5 — Checking service health, migration ledgers, queues and scheduled operations.', flush=True)
        try:
            server = postcheck.remote_report(alias, project, manifest['commit'], database_id,
                                            expected_migrations=migrations, baseline_flags=flags)
            report['server_postchecks'] = server
            if not server['software_checks_passed']:
                report['issues'].append('postcheck_failed')
            stage(report, 'Server post-deployment checks', 'passed' if server['software_checks_passed'] else 'needs_attention')
        except Exception:
            report['issues'].append('postcheck_unavailable')
            stage(report, 'Server post-deployment checks', 'unavailable')
    print('5/5 — Checking the website, public APIs and privacy boundaries.', flush=True)
    public = public_checks(target, require_release=report['application_deployment'] != 'preflight_only')
    report['public_postchecks'] = public
    if not public['passed']:
        report['issues'].append('public_checks_failed')
    stage(report, 'Public website and API checks', 'passed' if public['passed'] else 'needs_attention')
    report['software_checks_passed'] = not report['issues'] and report['application_deployment'] == 'completed'


def render_report(report):
    if report['software_checks_passed']:
        title = 'Application deployment verified'
    elif report['application_deployment'] == 'completed':
        title = 'Deployment completed — checks need attention'
    elif report['application_deployment'] in ('started', 'uncertain', 'uncertain_previous_operation'):
        title = 'Deployment result needs review'
    elif report['application_deployment'] == 'preflight_only':
        title = 'Preflight completed'
    else:
        title = 'Stopped before application deployment'
    rows = ''.join('<tr><td>' + html.escape(item['name']) + '</td><td>' + html.escape(item['status'].replace('_', ' ')) + '</td></tr>'
                   for item in report['stages'])
    issues = ''.join('<li>' + html.escape(EXPLANATIONS[code]) + '</li>' for code in report['issues'])
    pending = ''.join('<li>' + html.escape(value) + '</li>' for value in report['pending_acceptance'])
    connection = ''.join('<li>' + html.escape(item['alias']) + ': ' + html.escape(item['status'].replace('_', ' ')) + '</li>'
                         for item in (report.get('connection') or {}).get('attempts', []))
    problems = ''.join('<li>' + html.escape(code.replace('_', ' ')) + '</li>' for code in (report.get('server_postchecks') or {}).get('problems', []))
    return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' \
        '<title>PasoFi deployment result</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f4f8fc;color:#14283f;margin:0}' \
        'main{max-width:850px;margin:32px auto;padding:28px;background:white;border-radius:18px}h1{line-height:1.2;color:#0753b8}' \
        '.brand{font-weight:800;color:#0753b8}.badge{display:inline-block;background:#d9fc87;padding:5px 12px;border-radius:8px}' \
        'table{border-collapse:collapse;width:100%}td{padding:10px;border-bottom:1px solid #dce6ed}code{overflow-wrap:anywhere}' \
        '@media(max-width:600px){main{margin:12px;padding:18px}}</style><main><p class="brand">PasoFi · Mac deployment</p>' \
        '<h1>' + html.escape(title) + '</h1><p class="badge">Physical customer acceptance remains outstanding</p>' \
        '<p>Release: <code>' + html.escape(report.get('release') or 'not established') + '</code><br>Project: ' \
        + html.escape(report.get('project') or 'not established') + '</p><h2>Automatic steps</h2><table>' + rows + '</table>' \
        + ('<h2>Connection</h2><ul>' + connection + '</ul>' if connection else '') \
        + ('<h2>Items to resolve</h2><ul>' + issues + problems + '</ul>' if issues or problems else '') \
        + '<h2>Before serving customers</h2><ul>' + pending + '</ul><p>The software checks do not create a cash sale, send messages, ' \
        'configure physical routers, activate digital payments or prove a working customer Wi-Fi session.</p>' \
        '<p>Keep this report with the accompanying JSON result and the private server deployment record.</p></main></html>\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Deploy the pinned application release and run postchecks; no form inputs')
    parser.add_argument('--no-open', action='store_true', help='Do not open the result in the Mac browser')
    args = parser.parse_args(argv)
    os.umask(0o077)
    report = result_report()
    result_dir = None
    try:
        if sys.version_info < (3, 9):
            raise AutomaticError('package_invalid')
        directory = private_directory(ROOT / 'PasoFi_Results')
        controls = durable_state_root()
        with local_lock(controls):
            result_dir = directory / ('run-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
            private_directory(result_dir)
            try:
                execute(report, directory, apply=args.apply, state_root=controls)
            except AutomaticError as error:
                report['issues'].append(str(error))
            except KeyboardInterrupt:
                report['issues'].append('interrupted')
            except Exception:
                # No path, remote data or credential-containing exception is echoed.
                report['issues'].append('package_invalid')
            report['finished_at_utc'] = datetime.now(timezone.utc).isoformat()
            write_private(result_dir / 'result.json', report)
            write_private(result_dir / 'result.html', render_report(report))
    except (AutomaticError, OSError) as error:
        code = str(error) if isinstance(error, AutomaticError) else 'local_output_unavailable'
        print('STOPPED: ' + EXPLANATIONS[code], file=sys.stderr)
        return 1
    print('\nResult: ' + str(result_dir / 'result.html'))
    print('Shareable diagnostic: ' + str(result_dir / 'result.json'))
    for code in report['issues']:
        print('  ' + EXPLANATIONS[code])
    print('Customer hotspot acceptance: still required on the actual routers and phones.')
    if sys.platform == 'darwin' and not args.no_open:
        subprocess.run(['/usr/bin/open', str(result_dir / 'result.html')], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return 0 if report['software_checks_passed'] or (not args.apply and not report['issues']) else 1


if __name__ == '__main__':
    sys.exit(main())
