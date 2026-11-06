#!/usr/bin/env python3
"""Exercise the real deployment backup/restore helpers in the owned Docker lab.

The only adapter replaces production B2 configuration verification and the
three B2 secret bind mounts with this lab's encrypted POSIX repository/config
and disposable cipher environment. No pgBackRest JSON, image, database ID,
ledger, restore result or resource-inspection response is fabricated. The
production B2/root-owned-config/mount restrictions remain covered separately by
manual deployment/test_deployment_backup.py and test_deployment_restore.py.

This file is test-only. It provides no production helper bypass. It must be
called by run-lab.sh while its labelled source and three volumes are alive.
The real helper creates and cleans its own temporary bridge/volume/containers;
the shell lab continues to own and clean the source/repository/sentinel fixture.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import time


CONFIG = '/etc/pgbackrest/pgbackrest.conf'
PGDATA = '/var/lib/postgresql/data/pgdata'
HELPERS = Path('pasofi-backend/local-tools/manual deployment')
MARKER = '999_exact_deployment_restore_lab.sql'


class LabError(Exception):
    """Fixed lab diagnostics only; never print a cipher or full Docker inspect."""


def require(condition, message):
    if not condition:
        raise LabError(message)


def load_backup(source):
    path = source / HELPERS / 'deployment-backup.py'
    require(path.is_file() and not path.is_symlink(), 'Deployment backup helper is missing from the candidate checkout.')
    spec = importlib.util.spec_from_file_location('pasofi_lab_deployment_backup', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Fixture:
    def __init__(self, args, backup):
        require(re.fullmatch(r'[0-9a-f]{16}', args.lab_id), 'A valid disposable lab identifier is required.')
        self.prefix = 'pamofi-backup-lab-' + args.lab_id
        require(args.source_container == self.prefix + '-source'
                and args.repository_volume == self.prefix + '-repository'
                and args.sentinel_volume == self.prefix + '-restored-data', 'Only the current disposable lab fixture is supported.')
        self.lab_id = args.lab_id
        self.backup = backup
        self.real = backup.command
        self.source_name = args.source_container
        self.repo = args.repository_volume
        self.sentinel = args.sentinel_volume
        self.expected_config = Path(__file__).with_name('pgbackrest.conf').read_text()
        self.token = None
        self.created = {'container': set(), 'volume': set(), 'network': set()}
        self.restore = None
        self.captured = None
        self.newer = None
        self.marker_added = False
        self.marker_checksum = hashlib.sha256(('exact-restore-lab-' + args.lab_id).encode()).hexdigest()
        self.source = self.inspect('container', self.source_name)
        self.source_id = self.source['Id']
        self.image = self.source['Image']
        self.cipher = self.environment(self.source).get('PGBACKREST_REPO1_CIPHER_PASS', '')
        require(re.fullmatch(r'[0-9a-f]{64}', self.cipher), 'The fixture encryption key is invalid.')
        self.configuration(self.source)
        self.volume(self.sentinel)
        control = self.real(['docker', 'exec', '--user', 'postgres', '--env', 'LC_ALL=C', self.source_id,
                             'pg_controldata', PGDATA])
        identifiers = re.findall(r'^Database system identifier:\s*([0-9]+)\s*$', control, re.M)
        require(len(identifiers) == 1, 'The independent fixture database identity could not be retained.')
        self.database_id = identifiers[0]

    def inspect(self, kind, identifier):
        rows = json.loads(self.real(['docker', kind, 'inspect', identifier]))
        require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict, 'Fixture Docker inspection is ambiguous.')
        return rows[0]

    def environment(self, row):
        values = row.get('Config', {}).get('Env', [])
        require(type(values) is list and all(type(item) is str and '=' in item for item in values), 'Invalid fixture environment.')
        pairs = [item.split('=', 1) for item in values]
        require(len({key for key, _ in pairs}) == len(pairs), 'Duplicate fixture environment keys.')
        return dict(pairs)

    def volume(self, name):
        row = self.inspect('volume', name)
        require(row.get('Name') == name and row.get('Labels', {}).get('com.pamofi.backup-lab') == self.lab_id,
                'The test does not own its fixture volume.')
        return row

    def configuration(self, selected):
        """Real POSIX fixture checks replace only the production B2 guard."""
        row = self.inspect('container', self.source_name)
        require(selected.get('Id') == row.get('Id') == self.source_id
                and row.get('Name', '').lstrip('/') == self.source_name
                and row.get('Config', {}).get('Labels', {}).get('com.pamofi.backup-lab') == self.lab_id
                and row.get('State', {}).get('Running') is True, 'The running source is not this disposable lab.')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', row.get('Image', '')) and row['Image'] == self.image,
                'Fixture image identity changed or is mutable.')
        require(row.get('HostConfig', {}).get('NetworkMode') == 'none'
                and not row.get('HostConfig', {}).get('PortBindings'), 'The source fixture must have no network or published port.')
        mounts = row.get('Mounts', [])
        expected = {'/var/lib/postgresql/data': self.prefix + '-source-data', '/var/lib/pgbackrest': self.repo}
        require(len(mounts) == len(expected) and all(mount.get('Type') == 'volume'
                and expected.get(mount.get('Destination')) == mount.get('Name') and mount.get('RW') is True
                for mount in mounts), 'Unexpected source fixture mounts.')
        for name in expected.values():
            self.volume(name)
        env = self.environment(row)
        require(env.get('PGDATA') == PGDATA and env.get('POSTGRES_USER') == 'pamofi_bootstrap'
                and env.get('PGBACKREST_REPO1_CIPHER_PASS') == self.cipher, 'Fixture database/configuration environment changed.')
        actual = self.real(['docker', 'exec', row['Id'], 'cat', CONFIG])
        require(actual == self.expected_config and '[pamofi]\n' in actual
                and 'repo1-type=posix\n' in actual and 'repo1-cipher-type=aes-256-cbc\n' in actual,
                'The actual fixture configuration is not the inspected encrypted pamofi POSIX configuration.')
        version = self.real(['docker', 'exec', row['Id'], 'pgbackrest', 'version']).strip()
        require(re.fullmatch(r'pgBackRest 2\.57(?:\.0)?', version), 'The lab must exercise pgBackRest 2.57 metadata.')
        return row['Image']

    def pgbackrest(self, *args):
        # In 2.57, --repo is invalid for the local main role of check. This
        # fixture configuration contains exactly one repository, repo1.
        selection = [] if args == ('check',) else ['--repo=1']
        return ['docker', 'exec', '--user', 'postgres', self.source_id, 'pgbackrest',
                '--config=' + CONFIG, '--stanza=pamofi', *selection, *args]

    def info(self):
        return self.real(self.pgbackrest('--output=json', '--detail-level=full', 'info'), timeout=90)

    def sql(self, sql):
        return self.real(['docker', 'exec', '--user', 'postgres', self.source_id, 'psql', '-X', '-v',
                          'ON_ERROR_STOP=1', '-U', 'pamofi_bootstrap', '-d', 'pamofi_assistant', '-At', '-c', sql])

    def advance_latest(self, label):
        """Make falling back to latest observably wrong without faking metadata."""
        self.captured = self.backup.backup_info(self.info(), self.database_id, exact_label=label)
        require(self.captured == self.backup.backup_info(self.info(), self.database_id), 'Expected the freshly captured diff before the fixture advances latest.')
        require(label.endswith('D'), 'The helper did not capture a real differential backup.')
        require(self.sql("SELECT count(*) FROM schema_migrations WHERE name='" + MARKER + "'").strip() == '0', 'Synthetic ledger marker already exists.')
        self.sql("INSERT INTO schema_migrations(name,checksum) VALUES ('" + MARKER + "','" + self.marker_checksum + "')")
        self.marker_added = True
        # pgBackRest backup labels have second resolution. Deliberately make a
        # separate later label, with different real ledger contents.
        time.sleep(1.05)
        self.real(self.pgbackrest('--type=diff', '--no-expire-auto', 'backup'), timeout=1200)
        self.real(self.pgbackrest('check'), timeout=300)
        self.newer = self.backup.backup_info(self.info(), self.database_id)
        require(self.newer['label'] != label and self.newer['label'].endswith('D'), 'The newer marker-bearing differential backup was not established.')
        rows = self.restore.capture_ledgers(self.real, self.source_id)
        require(rows['pamofi_assistant'].get(MARKER) == self.marker_checksum, 'The newer source ledger must differ from the captured restore reference.')

    def adapted_create(self, argv):
        """Replace only the fixture-inapplicable repository environment/mounts."""
        name = argv[argv.index('--name') + 1]
        match = re.fullmatch(r'pasofi-deploy-restore-([0-9a-f]{32})-(init|fetch|server)', name)
        require(match and self.token == match[1], 'Unexpected restore container name or ownership token.')
        require(argv.count(self.image) == 1, 'Each real restore container must use the captured immutable image.')
        image_at = argv.index(self.image)
        options, arguments = argv[:image_at], argv[image_at:]
        if match[2] == 'fetch':
            labels = re.findall(r'--set=([0-9]{8}-[0-9]{6}F_[0-9]{8}-[0-9]{6}D)(?:\s|$)', ' '.join(arguments))
            require(len(labels) == 1 and self.captured is None, 'The restore must request exactly the captured differential label.')
            self.advance_latest(labels[0])
        output, dropped_mounts, dropped_env = [], set(), set()
        production_mounts = {'type=bind,src=' + self.restore.ROOT + '/secrets/' + secret + ',dst=/run/secrets/' + secret + ',readonly'
                             for secret in ('b2_key_id', 'b2_application_key', 'backup_cipher')}
        production_env = {'B2_BUCKET', 'B2_REGION', 'BACKUP_REPOSITORY_PREFIX', 'B2_KEY_ID_FILE', 'B2_APPLICATION_KEY_FILE', 'BACKUP_CIPHER_FILE'}
        index = 0
        while index < len(options):
            option = options[index]
            if option == '--mount':
                value = options[index + 1]
                if value.startswith('type=bind,'):
                    require(value in production_mounts and value not in dropped_mounts, 'Unexpected production bind mount in the fixture adapter.')
                    dropped_mounts.add(value)
                else:
                    require(value == 'type=volume,src=pasofi-deploy-restore-' + self.token + ',dst=/var/lib/postgresql/data',
                            'Restore must use only its new owned data volume.')
                    output.extend([option, value])
                index += 2
            elif option == '--env':
                value = options[index + 1]
                key, _, setting = value.partition('=')
                if key in production_env:
                    require(setting == self.backup.KNOWN_CONFIG[key] and key not in dropped_env, 'Unexpected production repository environment in fixture adapter.')
                    dropped_env.add(key)
                else:
                    require((key, setting) in {('PGDATA', PGDATA), ('PGBACKREST_CONFIG', CONFIG)}, 'Unexpected restore environment in fixture adapter.')
                    output.extend([option, value])
                index += 2
            else:
                output.append(option)
                index += 1
        if match[2] != 'init':
            require(dropped_mounts == production_mounts and dropped_env == production_env, 'Production fixture substitutions were incomplete.')
            output.extend(['--mount', 'type=volume,src=' + self.repo + ',dst=/var/lib/pgbackrest,readonly',
                           '--env', 'PGBACKREST_REPO1_CIPHER_PASS=' + self.cipher])
        else:
            require(not dropped_mounts and not dropped_env, 'Initializer unexpectedly requests repository credentials.')
        self.created['container'].add(name)
        return output + arguments

    def run(self, argv, *, timeout=30):
        argv = list(argv)
        creating = argv[:2] == ['docker', 'create'] or argv[:3] in (['docker', 'volume', 'create'], ['docker', 'network', 'create'])
        if creating:
            labels = [argv[index + 1] for index, value in enumerate(argv[:-1]) if value == '--label']
            tokens = [value.partition('=')[2] for value in labels if value.startswith('pasofi.restore.run=')]
            require(len(tokens) == 1 and re.fullmatch(r'[0-9a-f]{32}', tokens[0])
                    and 'pasofi.purpose=automatic-deployment-restore' in labels, 'Restore resource ownership labels are missing.')
            self.token = self.token or tokens[0]
            require(self.token == tokens[0], 'Restore unexpectedly changed ownership tokens.')
            if argv[1] == 'create':
                argv = self.adapted_create(argv)
            else:
                self.created[argv[1]].add(argv[-1])
        return self.real(argv, timeout=timeout)

    def assert_cleanup(self):
        require(self.token and {kind: len(names) for kind, names in self.created.items()}
                == {'container': 3, 'volume': 1, 'network': 1}, 'The real restore did not create the complete disposable resource set.')
        for kind in self.created:
            args = ['docker', kind, 'ls', '--filter', 'label=pasofi.restore.run=' + self.token]
            args += ['--all', '--format', '{{.ID}}'] if kind == 'container' else ['--format', '{{.Name}}']
            require(not self.real(args).strip(), 'Owned restore resources remain after real cleanup.')
        self.volume(self.sentinel)  # Existing unused fixture volume must survive.
        self.configuration(self.source)  # Source image/data/repository are intact.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-container', required=True)
    parser.add_argument('--repository-volume', required=True)
    parser.add_argument('--sentinel-volume', required=True)
    parser.add_argument('--lab-id', required=True)
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    source = args.source_root.resolve()
    backup = load_backup(source)
    fixture = Fixture(args, backup)
    original_loader = backup.restore_module

    def load_fixture_restore(path):
        module, digest = original_loader(path)  # Keep exact pinned helper-byte verification.
        module.CONFIG = CONFIG
        fixture.restore = module
        return module, digest

    backup.BACKUP_CONFIG = CONFIG
    backup.configuration = fixture.configuration
    backup.command = fixture.run
    backup.restore_module = load_fixture_restore
    try:
        with tempfile.TemporaryDirectory(prefix='pasofi-exact-backup-lab-') as directory:
            release = Path(directory)
            retained = release / 'retained-database-id'
            retained.write_text(fixture.database_id + '\n')
            retained.chmod(0o600)
            # The initial full and requested diff must not tie at pgBackRest's
            # integer-second completion timestamp in a very fast small lab.
            time.sleep(1.05)
            evidence = backup.prepare_backup(fixture.source, retained.read_text().strip(), source, release)
            require(fixture.captured and fixture.newer and evidence['backup_label'] == fixture.captured['label']
                    and evidence['restored_backup_label'] == fixture.captured['label']
                    and evidence['backup_label'] != fixture.newer['label'], 'Restore evidence did not retain the captured earlier diff.')
            require(evidence['restore_image_id'] == fixture.image and evidence['cluster_identity'] == 'matched'
                    and evidence['migration_ledgers'] == 'matched_all_five' and evidence['cleanup'] == 'passed'
                    and evidence['off_host_recovery_tested'] is False, 'The real helper evidence is incomplete.')
            require(json.loads((release / 'backup-evidence.json').read_text()) == evidence
                    and (release / 'backup-evidence.json').stat().st_mode & 0o777 == 0o600, 'Captured restore evidence was not written privately.')
            fixture.assert_cleanup()
    finally:
        # Remove only our synthetic row; shell cleanup owns all fixture volumes.
        if fixture.marker_added:
            fixture.sql("DELETE FROM schema_migrations WHERE name='" + MARKER + "' AND checksum='" + fixture.marker_checksum + "'")
    print('PASS: real captured diff, unchanged pgBackRest JSON, newer differing backup, immutable image, retained cluster ID, all five ledgers and owned cleanup.')


if __name__ == '__main__':
    main()
