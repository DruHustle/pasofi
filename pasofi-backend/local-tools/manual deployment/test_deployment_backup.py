"""Backup qualification regression tests, entirely local and without secrets."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
from test_deployment_restore import DockerBoundary, IMAGE, DATABASE_ID, BACKUP_LABEL

spec = importlib.util.spec_from_file_location('backup_under_test', Path(__file__).with_name('deployment-backup.py'))
BACKUP = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BACKUP)
REPO = Path(__file__).resolve().parents[3]


def metadata(label=BACKUP_LABEL, timestamp=None):
    return [{'name': 'pamofi', 'cipher': 'aes-256-cbc', 'status': {'code': 0},
             'repo': [{'key': 1, 'cipher': 'aes-256-cbc', 'status': {'code': 0}}],
             'db': [{'id': 1, 'repo-key': 1, 'system-id': int(DATABASE_ID), 'version': '17'}],
             'backup': [{'label': label, 'error': False, 'database': {'id': 1, 'repo-key': 1},
                         'timestamp': {'start': 1793960000, 'stop': int(time.time()) if timestamp is None else timestamp}}]}]


def container():
    return {'Id': 'd' * 64, 'Image': IMAGE, 'State': {'Running': True},
            'Config': {'Env': [key + '=' + value for key, value in BACKUP.KNOWN_CONFIG.items()]},
            'Mounts': [{'Destination': '/run/secrets/' + name, 'Source': str(BACKUP.PRODUCTION_ROOT / 'secrets' / name),
                        'Type': 'bind', 'RW': False} for name in ('b2_key_id', 'b2_application_key', 'backup_cipher')]}


class BackupBoundary(DockerBoundary):
    def __init__(self):
        super().__init__()
        self.created_backup = False
        self.now = int(time.time())
        self.remove_captured_label = False
        self.info_calls = 0

    def __call__(self, argv, *, timeout=30):
        if 'pgbackrest' in argv:
            self.calls.append(argv)
            if argv[-1] == 'backup':
                self.created_backup = True
                return ''
            if argv[-1] == 'check':
                return ''
            if argv[-1] == 'info':
                self.info_calls += 1
                label = BACKUP_LABEL if self.created_backup else '20261105-000001F'
                if self.remove_captured_label and self.info_calls >= 3:
                    label = '20261106-000001F_20261106-150001D'
                return json.dumps(metadata(label, self.now if self.created_backup else self.now - 86400))
        if argv[-1] == BACKUP.CONFIGURATION_CHECK:
            self.calls.append(argv)
            return 'qualified-encrypted-backup\n'
        return super().__call__(argv, timeout=timeout)


class MetadataTests(unittest.TestCase):
    def test_repo_one_metadata_preserves_large_integer_exactly(self):
        result = BACKUP.backup_info(json.dumps(metadata()), DATABASE_ID)
        self.assertEqual(result['label'], BACKUP_LABEL)
        with self.assertRaises(BACKUP.BackupError):
            BACKUP.backup_info(json.dumps(metadata()), str(int(DATABASE_ID) + 1))

    def test_unhealthy_or_ambiguous_repo_and_bool_numeric_fields_cannot_qualify(self):
        modifiers = [lambda s: s['status'].update(code=False), lambda s: s['repo'][0]['status'].update(code=False),
                     lambda s: s['repo'][0].update(key=True), lambda s: s['repo'][0].update(cipher='none'),
                     lambda s: s['repo'][0]['status'].update(code=2), lambda s: s['repo'].append(copy.deepcopy(s['repo'][0])),
                     lambda s: s['db'][0].update(id=True), lambda s: s['db'][0].update(**{'repo-key': True}),
                     lambda s: s['db'][0].update(**{'system-id': float(DATABASE_ID)}), lambda s: s['db'][0].update(version=17),
                     lambda s: s['db'].append(copy.deepcopy(s['db'][0])), lambda s: s['backup'][0]['database'].update(id=True),
                     lambda s: s['backup'][0]['timestamp'].update(stop=True), lambda s: s['backup'][0].update(error=True),
                     lambda s: s['backup'][0].pop('error')]
        for index, modify in enumerate(modifiers):
            data = metadata()
            modify(data[0])
            with self.subTest(index=index), self.assertRaises(BACKUP.BackupError):
                BACKUP.backup_info(json.dumps(data), DATABASE_ID)

    def test_bad_newest_does_not_fall_back_to_old_success_and_exact_label_does_not_follow_latest(self):
        now = int(time.time())
        data = metadata(timestamp=now - 5)
        newer = copy.deepcopy(data[0]['backup'][0])
        newer.update(label='20261106-000001F_20261106-150001D', error=True)
        newer['timestamp']['stop'] = now
        data[0]['backup'].append(newer)
        with self.assertRaises(BACKUP.BackupError):
            BACKUP.backup_info(json.dumps(data), DATABASE_ID)
        self.assertEqual(BACKUP.backup_info(json.dumps(data), DATABASE_ID, exact_label=BACKUP_LABEL)['label'], BACKUP_LABEL)
        with self.assertRaises(BACKUP.BackupError):
            BACKUP.backup_info(json.dumps(data), DATABASE_ID, exact_label='20260101-000001F')


class ConfigurationTests(unittest.TestCase):
    def test_environment_overrides_duplicates_and_secret_mount_changes_stop_before_commands(self):
        for extra in ('PGBACKREST_REPO1_CIPHER_TYPE=none', 'PGBACKREST_CONFIG_INCLUDE_PATH=/unsafe',
                      'PGBACKREST_CONFIG=/unexpected', 'PGBACKREST_STANZA=other'):
            data = container()
            data['Config']['Env'].append(extra)
            with self.subTest(extra=extra), patch.object(BACKUP, 'command') as command, self.assertRaises(BACKUP.BackupError):
                BACKUP.configuration(data)
            command.assert_not_called()
        data = container()
        data['Mounts'][0]['RW'] = True
        with patch.object(BACKUP, 'command') as command, self.assertRaises(BACKUP.BackupError):
            BACKUP.configuration(data)
        command.assert_not_called()

    def test_actual_generated_config_and_strict_awk_checker_execute_locally(self):
        with tempfile.TemporaryDirectory(prefix='pasofi config ') as directory:
            root = Path(directory)
            values = dict(os.environ, **BACKUP.KNOWN_CONFIG)
            config = root / 'pgbackrest.conf'
            values['PGBACKREST_CONFIG'] = str(config)
            for variable, name, length in (('B2_KEY_ID_FILE', 'id', 12), ('B2_APPLICATION_KEY_FILE', 'key', 32), ('BACKUP_CIPHER_FILE', 'cipher', 64)):
                path = root / name
                path.write_text('a' * length + '\n')
                values[variable] = str(path)
            renderer = REPO / 'pasofi-backend/infra/backup-production/render-config.sh'
            result = subprocess.run(['sh', str(renderer), str(config)], env=values, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            baseline = config.read_text()
            script = BACKUP.CONFIGURATION_CHECK.replace('f=/run/pgbackrest/pgbackrest.conf', 'f=' + shlex.quote(str(config)))
            result = subprocess.run(['sh', '-c', script], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'qualified-encrypted-backup\n')
            for suffix in ('\n[global:restore]\nrepo1-path=/elsewhere\n', '\nrepo2-type=s3\n', '\nrepo1-cipher-type=none\n', '\n[other]\n'):
                config.write_text(baseline + suffix)
                result = subprocess.run(['sh', '-c', script], capture_output=True, text=True, check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')


class BackupFlowTests(unittest.TestCase):
    def test_complete_guard_requires_fresh_label_exact_restore_and_durable_evidence(self):
        docker = BackupBoundary()
        with tempfile.TemporaryDirectory() as directory, patch.object(BACKUP, 'command', side_effect=docker), redirect_stdout(io.StringIO()):
            evidence = BACKUP.prepare_backup(container(), DATABASE_ID, REPO, Path(directory))
            saved = Path(directory) / 'backup-evidence.json'
            self.assertEqual(json.loads(saved.read_text()), evidence)
            self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.assertEqual(evidence['backup_label'], evidence['restored_backup_label'])
        self.assertEqual(evidence['restore_image_id'], IMAGE)
        self.assertEqual(evidence['cleanup'], 'passed')
        commands = [argv for argv in docker.calls if 'pgbackrest' in argv]
        self.assertTrue(all('--config=/run/pgbackrest/pgbackrest.conf' in argv and '--repo=1' in argv for argv in commands))
        self.assertIn('--no-expire-auto', next(argv for argv in commands if argv[-1] == 'backup'))

    def test_missing_captured_backup_after_restore_does_not_write_success(self):
        docker = BackupBoundary()
        docker.remove_captured_label = True
        with tempfile.TemporaryDirectory() as directory, patch.object(BACKUP, 'command', side_effect=docker), redirect_stdout(io.StringIO()):
            with self.assertRaises(BACKUP.BackupError):
                BACKUP.prepare_backup(container(), DATABASE_ID, REPO, Path(directory))
            self.assertFalse((Path(directory) / 'backup-evidence.json').exists())

    def test_failed_command_diagnostics_never_expose_raw_output(self):
        with self.assertRaises(BACKUP.BackupError) as error:
            BACKUP.command([sys.executable, '-c', 'import sys; print("SECRET-KEY"); print("SECRET-KEY",file=sys.stderr);sys.exit(1)'])
        self.assertNotIn('SECRET-KEY', str(error.exception))


if __name__ == '__main__':
    unittest.main()
