"""Isolated exact-restore protocol checks using an in-memory Docker boundary."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('restore_under_test', Path(__file__).with_name('deployment-restore.py'))
RESTORE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(RESTORE)
IMAGE = 'sha256:' + 'a' * 64
DATABASE_ID = '1234567890123456789'
BACKUP_LABEL = '20261106-000001F_20261106-140001D'
LEDGER_ROWS = [{'name': '001_initial.sql', 'checksum': 'b' * 64}]
LEDGERS = {name: {'001_initial.sql': 'b' * 64} for name in RESTORE.DATABASES}


class DockerBoundary:
    def __init__(self):
        self.calls, self.removed = [], []
        self.resources = {kind: {} for kind in ('container', 'volume', 'network')}
        self.counter = 0
        self.fail_fetch = False
        self.lose_create = False
        self.fail_cleanup = False
        self.wrong_cluster = False
        self.wrong_ledger = False
        self.route = []

    def identifier(self):
        self.counter += 1
        return format(self.counter, '064x')

    def __call__(self, argv, *, timeout=30):
        self.calls.append(argv)
        if argv[:2] == ['ip', '-json']:
            return json.dumps(self.route)
        assert argv[0] == 'docker', argv
        if argv[1:3] == ['network', 'ls'] and '--quiet' in argv:
            return ''
        if argv[1] in self.resources:
            kind, operation = argv[1:3]
            rows = self.resources[kind]
            if operation == 'ls':
                token = argv[argv.index('--filter') + 1].split('=', 2)[2]
                selected = [row for row in rows.values() if (row.get('Config', {}).get('Labels') or row.get('Labels'))['pasofi.restore.run'] == token]
                return '\n'.join(row['Name'] if kind == 'volume' else row['Id'] for row in selected)
            if operation == 'inspect':
                row = next(row for key, row in rows.items() if key == argv[3] or row['Name'].lstrip('/') == argv[3])
                return json.dumps([row])
            if operation == 'create':
                labels = dict(argv[index + 1].split('=', 1) for index, value in enumerate(argv) if value == '--label')
                name = argv[-1]
                identifier = name if kind == 'volume' else self.identifier()
                row = {'Name': name, 'Labels': labels, 'Id': identifier}
                rows[identifier] = row
                return identifier
            if operation == 'rm':
                if self.fail_cleanup and kind == 'volume':
                    raise OSError('cleanup-failed')
                self.removed.append((kind, argv[-1]))
                del rows[argv[-1]]
                return ''
        if argv[1] == 'create':
            name = argv[argv.index('--name') + 1]
            labels = dict(argv[index + 1].split('=', 1) for index, value in enumerate(argv) if value == '--label')
            identifier = self.identifier()
            self.resources['container'][identifier] = {'Id': identifier, 'Name': '/' + name,
                'Image': next(value for value in argv if value.startswith('sha256:')), 'Config': {'Labels': labels},
                'HostConfig': {'PortBindings': {}}, 'State': {'Running': False, 'ExitCode': 0}}
            if self.lose_create and name.endswith('-fetch'):
                raise OSError('lost-result-after-create')
            return identifier
        if argv[1] == 'start':
            row = self.resources['container'][argv[-1]]
            if self.fail_fetch and row['Name'].endswith('-fetch'):
                raise OSError('SECRET-RESTORE-DIAGNOSTIC')
            if '--attach' not in argv:
                row['State']['Running'] = True
            return ''
        if argv[1] == 'exec':
            if 'pg_controldata' in argv:
                return 'Database system identifier: ' + ('9999999999999999999' if self.wrong_cluster else DATABASE_ID) + '\n'
            if argv[-1] == 'SELECT pg_is_in_recovery()':
                return 'f\n'
            if argv[-1] == RESTORE.LEDGER_SQL:
                rows = [{'name': '001_initial.sql', 'checksum': 'c' * 64}] if self.wrong_ledger else LEDGER_ROWS
                return json.dumps(rows)
        raise AssertionError(argv)


class ExactRestoreTests(unittest.TestCase):
    def invoke(self, docker, **overrides):
        args = dict(image=IMAGE, backup_label=BACKUP_LABEL, expected_id=DATABASE_ID, expected_ledgers=LEDGERS)
        args.update(overrides)
        return RESTORE.restore_exact(docker, **args)

    def test_exact_label_immutable_image_ledgers_and_owned_cleanup(self):
        docker = DockerBoundary()
        result = self.invoke(docker)
        self.assertEqual(result['backup_label'], BACKUP_LABEL)
        self.assertEqual(result['image_id'], IMAGE)
        self.assertEqual(result['migration_ledgers'], 'matched_all_five')
        self.assertFalse(result['off_host_recovery_tested'])
        creates = [argv for argv in docker.calls if argv[:2] == ['docker', 'create']]
        self.assertEqual(len(creates), 3)
        self.assertTrue(all(IMAGE in argv and '--pull=never' in argv for argv in creates))
        restore = next(argv for argv in creates if any('--set=' in item for item in argv))
        self.assertIn('--set=' + BACKUP_LABEL, restore[-1])
        self.assertIn('--repo=1', restore[-1])
        self.assertIn('--type=immediate', restore[-1])
        self.assertTrue(all('--publish' not in argv and '-p' not in argv for argv in creates))
        self.assertFalse(any('pamofi_postgres_data' in item for argv in creates for item in argv))
        self.assertTrue(all(not rows for rows in docker.resources.values()))
        self.assertEqual(len(docker.removed), 5)

    def test_lost_create_and_failed_restore_still_remove_only_owned_resources(self):
        for attribute in ('fail_fetch', 'lose_create'):
            docker = DockerBoundary()
            setattr(docker, attribute, True)
            with self.subTest(attribute=attribute), self.assertRaises(OSError):
                self.invoke(docker)
            self.assertTrue(all(not rows for rows in docker.resources.values()))

    def test_cluster_and_ledger_mismatches_fail_with_cleanup(self):
        for attribute in ('wrong_cluster', 'wrong_ledger'):
            docker = DockerBoundary()
            setattr(docker, attribute, True)
            with self.subTest(attribute=attribute), self.assertRaises(RESTORE.RestoreError):
                self.invoke(docker)
            self.assertTrue(all(not rows for rows in docker.resources.values()))

    def test_unconfirmed_cleanup_prevents_success(self):
        docker = DockerBoundary()
        docker.fail_cleanup = True
        with self.assertRaisesRegex(RESTORE.RestoreError, 'cleanup could not be confirmed'):
            self.invoke(docker)
        self.assertTrue(docker.resources['volume'])

    def test_mutable_image_bad_label_missing_ledgers_and_route_overlap_stop_before_creation(self):
        for overrides in ({'image': 'postgres:latest'}, {'backup_label': BACKUP_LABEL + ';touch bad'}, {'expected_ledgers': {}}):
            docker = DockerBoundary()
            with self.subTest(overrides=overrides), self.assertRaises(RESTORE.RestoreError):
                self.invoke(docker, **overrides)
            self.assertEqual(docker.calls, [])
        docker = DockerBoundary()
        docker.route = [{'dst': '10.245.244.0/24'}]
        with self.assertRaisesRegex(RESTORE.RestoreError, 'overlaps'):
            self.invoke(docker)
        self.assertFalse(any('create' in argv for argv in docker.calls))

    def test_ownership_mismatch_cannot_delete_foreign_resource(self):
        docker = DockerBoundary()
        resources = RESTORE.Resources(docker)
        foreign = 'f' * 64
        docker.resources['container'][foreign] = {'Id': foreign, 'Name': '/production-postgres',
            'Config': {'Labels': {'pasofi.restore.run': resources.token, 'pasofi.purpose': RESTORE.PURPOSE}}}
        with self.assertRaisesRegex(RESTORE.RestoreError, 'cleanup could not be confirmed'):
            resources.cleanup()
        self.assertIn(foreign, docker.resources['container'])
        self.assertEqual(docker.removed, [])

    def test_duplicate_or_invalid_ledger_is_rejected(self):
        for rows in ([], LEDGER_ROWS + LEDGER_ROWS, [{'name': '../private', 'checksum': 'b' * 64}],
                     [{'name': '001_initial.sql', 'checksum': True}]):
            with self.subTest(rows=rows), self.assertRaises(RESTORE.RestoreError):
                RESTORE.ledger(json.dumps(rows))


if __name__ == '__main__':
    unittest.main()
