#!/usr/bin/env python3
"""Require a fresh encrypted backup and exact isolated restore before deployment."""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time

PRODUCTION_ROOT = Path('/home/ubuntu/pamofi/production')
BACKUP_CONFIG = '/run/pgbackrest/pgbackrest.conf'
HELPER_PATH = 'pasofi-backend/local-tools/manual deployment/'
MAX_OUTPUT = 2 * 1024 * 1024
KNOWN_CONFIG = {
    'B2_BUCKET': 'pamofi-b2-blazebucket', 'B2_REGION': 'eu-central-003',
    'BACKUP_REPOSITORY_PREFIX': '/pamofi-production', 'PGDATA': '/var/lib/postgresql/data/pgdata',
    'PGBACKREST_CONFIG': BACKUP_CONFIG, 'B2_KEY_ID_FILE': '/run/secrets/b2_key_id',
    'B2_APPLICATION_KEY_FILE': '/run/secrets/b2_application_key', 'BACKUP_CIPHER_FILE': '/run/secrets/backup_cipher',
}


class BackupError(Exception):
    """Only fixed messages are exposed to the caller."""


def require(condition, message):
    if not condition:
        raise BackupError(message)


def command(argv, *, timeout=30):
    """Bound both output streams and time; raw diagnostics never leave this module."""
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        raise BackupError('A required backup command is unavailable; deployment has not started.') from None
    result = bytearray()
    sizes = {'out': 0, 'err': 0}
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            for stream, name in ((process.stdout, 'out'), (process.stderr, 'err')):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'Backup or restore timed out. Inspect its server state before retrying; deployment has not started.')
                for key, _ in selector.select(min(remaining, 30)):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    sizes[key.data] += len(chunk)
                    require(sizes[key.data] <= MAX_OUTPUT, 'Backup diagnostic output exceeded its limit; deployment has not started.')
                    if key.data == 'out':
                        result.extend(chunk)
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
        require(process.returncode == 0, 'The protected backup or restore check failed; deployment has not started. Inspect the server backup records.')
        return result.decode('utf-8')
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        raise BackupError('The backup command result is unavailable. Inspect its server state before retrying; deployment has not started.') from None
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        process.stderr.close()


CONFIGURATION_CHECK = r'''set -eu
f=/run/pgbackrest/pgbackrest.conf
[ -f "$f" ] && [ ! -L "$f" ]
[ "$(stat -c %a "$f")" = 600 ]
[ "$(stat -c %u "$f")" = "$(id -u)" ]
awk '
BEGIN {
  expect["repo1-type"]="s3"; expect["repo1-s3-bucket"]="pamofi-b2-blazebucket";
  expect["repo1-s3-endpoint"]="s3.eu-central-003.backblazeb2.com";
  expect["repo1-s3-region"]="eu-central-003"; expect["repo1-s3-uri-style"]="path";
  expect["repo1-storage-verify-tls"]="y"; expect["repo1-path"]="/pamofi-production";
  expect["repo1-cipher-type"]="aes-256-cbc"; expect["repo1-bundle"]="y";
  expect["repo1-retention-full"]="4"; expect["repo1-retention-diff"]="14";
  expect["archive-check"]="y"; expect["archive-copy"]="y"; expect["start-fast"]="y";
  expect["process-max"]="2"; expect["log-level-console"]="warn"; expect["log-level-file"]="off";
  expect["pg1-path"]="/var/lib/postgresql/data/pgdata";
  expect["pg1-socket-path"]="/var/run/postgresql"; expect["pg1-user"]="pamofi_bootstrap";
  secret["repo1-s3-key"]=8; secret["repo1-s3-key-secret"]=20; secret["repo1-cipher-pass"]=32;
}
$0=="" {next}
$0=="[global]" {if(section!="" || global++) bad=1; section="global"; next}
$0=="[pamofi]" {if(section!="global" || stanza++) bad=1; section="pamofi"; next}
{
  splitAt=index($0,"="); if(!splitAt) {bad=1; next}
  key=substr($0,1,splitAt-1); value=substr($0,splitAt+1);
  if(seen[key]++) bad=1;
  if((key ~ /^pg1-/ && section!="pamofi") || (key !~ /^pg1-/ && section!="global")) bad=1;
  if(key in expect) {if(value!=expect[key]) bad=1}
  else if(key in secret) {if(length(value)<secret[key] || length(value)>512 || value !~ /^[A-Za-z0-9+\/=_.-]+$/) bad=1}
  else bad=1;
}
END {
  for(key in expect) if(seen[key]!=1) bad=1;
  for(key in secret) if(seen[key]!=1) bad=1;
  exit !(global==1 && stanza==1 && !bad);
}' "$f"
printf 'qualified-encrypted-backup\n'
'''


def configuration(container):
    require(type(container) is dict and type(container.get('Id')) is str and re.fullmatch(r'[0-9a-f]{64}', container['Id']),
            'The selected database container is not established.')
    image = container.get('Image')
    require(type(image) is str and re.fullmatch(r'sha256:[0-9a-f]{64}', image), 'The existing database image is not immutable.')
    env = container.get('Config', {}).get('Env')
    require(type(env) is list and len(env) <= 256, 'The existing backup environment is invalid.')
    values = {}
    for item in env:
        require(type(item) is str and '=' in item, 'The existing backup environment is invalid.')
        key, value = item.split('=', 1)
        require(key not in values, 'Duplicate backup environment keys are not supported.')
        values[key] = value
        require(not key.startswith('PGBACKREST_') or key == 'PGBACKREST_CONFIG',
                'A pgBackRest environment override prevents backup qualification.')
    require(all(values.get(key) == value for key, value in KNOWN_CONFIG.items()),
            'The existing backup configuration differs from the qualified restore procedure; deployment has not started.')
    mounts = container.get('Mounts')
    require(type(mounts) is list and len(mounts) <= 100, 'The protected backup credential mounts are invalid.')
    for secret in ('b2_key_id', 'b2_application_key', 'backup_cipher'):
        matches = [mount for mount in mounts if type(mount) is dict and mount.get('Destination') == '/run/secrets/' + secret]
        require(len(matches) == 1 and matches[0].get('Type') == 'bind' and matches[0].get('RW') is False
                and matches[0].get('Source') == str(PRODUCTION_ROOT / 'secrets' / secret),
                'The protected backup credential mounts differ from the qualified restore procedure; deployment has not started.')
    require(container.get('State', {}).get('Running') is True, 'The selected database is not running; deployment has not started.')
    # Explicit --config on every pgBackRest call excludes implicit include files.
    # The exact supported sections/keys below exclude stanza/command overrides.
    require(command(['docker', 'exec', '--user', 'postgres', container['Id'], 'sh', '-c', CONFIGURATION_CHECK]).strip()
            == 'qualified-encrypted-backup', 'The encrypted backup configuration could not be verified.')
    return image


def backup_info(raw, expected_id, *, now=None, exact_label=None):
    """Read pgBackRest 2.57 metadata with exact integers, including repo1 status."""
    try:
        data = json.loads(raw)
        require(type(data) is list and len(data) == 1 and type(data[0]) is dict and data[0].get('name') == 'pamofi',
                'The expected backup stanza is missing or ambiguous.')
        stanza = data[0]
        status = stanza.get('status', {})
        require(type(status.get('code')) is int and status['code'] == 0 and stanza.get('cipher') == 'aes-256-cbc',
                'The encrypted backup repository is not healthy.')
        repositories = stanza.get('repo')
        require(type(repositories) is list and len(repositories) == 1 and type(repositories[0]) is dict,
                'The selected backup repository is missing or ambiguous.')
        repo = repositories[0]
        require(type(repo.get('key')) is int and repo['key'] == 1 and repo.get('cipher') == 'aes-256-cbc'
                and type(repo.get('status', {}).get('code')) is int and repo['status']['code'] == 0,
                'The selected encrypted backup repository is not healthy.')
        databases, backups = stanza.get('db'), stanza.get('backup')
        require(type(databases) is list and 1 <= len(databases) <= 100
                and type(backups) is list and 1 <= len(backups) <= 10000,
                'The backup repository has no usable database history.')
        labels = set()
        for item in backups:
            require(type(item) is dict and type(item.get('label')) is str
                    and re.fullmatch(r'[0-9]{8}-[0-9]{6}F(?:_[0-9]{8}-[0-9]{6}[DI])?', item['label'])
                    and item['label'] not in labels and type(item.get('timestamp', {}).get('stop')) is int
                    and 0 < item['timestamp']['stop'] <= (time.time() if now is None else now) + 60,
                    'Backup metadata contains an invalid label or completion time.')
            labels.add(item['label'])
        if exact_label is None:
            selected = max(backups, key=lambda item: item['timestamp']['stop'])
        else:
            matches = [item for item in backups if item['label'] == exact_label]
            require(len(matches) == 1, 'The captured backup label is no longer available.')
            selected = matches[0]
        require(selected.get('error') is False, 'The selected backup did not explicitly complete without errors.')
        db = selected.get('database', {})
        require(type(db.get('id')) is int and db['id'] > 0 and type(db.get('repo-key')) is int and db['repo-key'] == 1,
                'The selected backup database identity is invalid.')
        matches = [row for row in databases if type(row) is dict and type(row.get('id')) is int and row['id'] == db['id']
                   and type(row.get('repo-key')) is int and row['repo-key'] == 1]
        require(len(matches) == 1 and type(matches[0].get('system-id')) is int
                and 0 < matches[0]['system-id'] < 2**64 and str(matches[0]['system-id']) == expected_id
                and matches[0].get('version') == '17',
                'The backup cluster identity differs from the independently retained production record.')
        return {'label': selected['label'], 'completed': selected['timestamp']['stop']}
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        raise BackupError('Backup metadata is unavailable or invalid.') from None


def restore_module(source):
    """Both uploaded helpers must be byte-identical to the pinned source payload."""
    try:
        for filename in ('deployment-backup.py', 'deployment-restore.py'):
            local = Path(__file__).resolve().with_name(filename)
            pinned = Path(source) / HELPER_PATH / filename
            require(local.is_file() and not local.is_symlink() and pinned.is_file() and not pinned.is_symlink()
                    and local.stat().st_size <= 128 * 1024 and pinned.stat().st_size <= 128 * 1024
                    and local.read_bytes() == pinned.read_bytes(), 'The backup helpers differ from the pinned release source.')
        path = Path(source) / HELPER_PATH / 'deployment-restore.py'
        specification = importlib.util.spec_from_file_location('pasofi_exact_restore', path)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module, hashlib.sha256(path.read_bytes()).hexdigest()
    except (OSError, AttributeError, ImportError):
        raise BackupError('The pinned isolated restore procedure is unavailable.') from None


def prepare_backup(container, expected_database_id, source, release):
    require(type(expected_database_id) is str and re.fullmatch(r'[0-9]{10,30}', expected_database_id),
            'An independently retained database identity is required before backup qualification.')
    restore, program_hash = restore_module(source)
    image = configuration(container)
    postgres = container['Id']
    base = ['docker', 'exec', '--user', 'postgres', postgres, 'pgbackrest', '--config=' + BACKUP_CONFIG, '--stanza=pamofi']
    selected_repo = base + ['--repo=1']
    info = ['--output=json', '--detail-level=full', 'info']
    before = backup_info(command(selected_repo + info, timeout=90), expected_database_id)
    try:
        ledgers = restore.capture_ledgers(command, postgres)
        started = int(time.time())
        print('Creating a fresh encrypted backup using the existing protected repository.', flush=True)
        command(selected_repo + ['--type=diff', '--no-expire-auto', 'backup'], timeout=4 * 3600)
        # pgBackRest 2.57 permits --repo for check's remote role only, not its
        # local main role. The validated config/env above permits only repo1.
        command(base + ['check'], timeout=300)
        fresh = backup_info(command(selected_repo + info, timeout=90), expected_database_id)
        require(fresh['label'] != before['label'] and fresh['completed'] >= started - 5,
                'A newly completed backup was not established; deployment has not started.')
        require(configuration(container) == image, 'The immutable restore image changed during backup qualification.')
        print('Restoring the captured backup label into a separate volume and checking all five migration ledgers.', flush=True)
        restored = restore.restore_exact(command, image=image, backup_label=fresh['label'],
                                         expected_id=expected_database_id, expected_ledgers=ledgers)
        # Do not silently accept a replacement latest backup or a disappeared set.
        require(backup_info(command(selected_repo + info, timeout=90), expected_database_id, exact_label=fresh['label']) == fresh,
                'The captured backup metadata changed during restore qualification.')
    except restore.RestoreError as error:
        raise BackupError(str(error)) from None
    require(restored == {'status': 'passed', 'backup_label': fresh['label'], 'image_id': image,
                         'cluster_identity': 'matched', 'migration_ledgers': 'matched_all_five', 'cleanup': 'passed',
                         'host_ports': 'none', 'restore_scope': 'new_disposable_volume_on_existing_host',
                         'off_host_recovery_tested': False}, 'The exact isolated restore evidence is incomplete.')
    evidence = {
        'schema': 1, 'status': 'passed', 'encrypted_backup': 'passed', 'fresh_backup': 'passed',
        'isolated_restore': 'passed', 'cluster_identity': 'matched',
        'completed_at_utc': datetime.now(timezone.utc).isoformat(), 'backup_label': fresh['label'],
        'backup_completed_at_unix': fresh['completed'], 'restore_scope': 'new_disposable_volume_on_existing_host',
        'restore_program_sha256': program_hash, 'restore_image_id': image, 'restored_backup_label': fresh['label'],
        'migration_ledgers': 'matched_all_five', 'cleanup': 'passed', 'off_host_recovery_tested': False,
    }
    descriptor = os.open(Path(release) / 'backup-evidence.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        json.dump(evidence, handle, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    print('Fresh encrypted backup and exact isolated restore checks passed.', flush=True)
    return evidence
