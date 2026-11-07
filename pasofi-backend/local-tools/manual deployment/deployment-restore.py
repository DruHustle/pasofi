#!/usr/bin/env python3
"""Restore one captured backup into owned, disposable Docker resources only.

Called by deployment-backup.py. The caller supplies the immutable running image,
exact backup label, retained system identifier and pre-backup migration ledgers.
No production data volume, host port or mutable image tag is used here.
"""
import hashlib
import ipaddress
import json
import re
import secrets
import time

DATABASES = ('pamofi_identity', 'pamofi_prepaid_access', 'pamofi_network', 'pamofi_notification', 'pamofi_assistant')
SUBNET = '10.245.244.0/24'
PURPOSE = 'automatic-deployment-restore'
ROOT = '/home/ubuntu/pamofi/production'
PGDATA = '/var/lib/postgresql/data/pgdata'
CONFIG = '/run/pgbackrest/pgbackrest.conf'
BUCKET_SHA256 = 'bb211da03962e46e1e2597137b4fb176aca1ce71668088dea69bc7a95eefd869'
LABEL_PATTERN = r'[0-9]{8}-[0-9]{6}F(?:_[0-9]{8}-[0-9]{6}[DI])?'
LEDGER_SQL = "SELECT coalesce(json_agg(json_build_object('name',name,'checksum',checksum) ORDER BY name),'[]'::json) FROM schema_migrations"
PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=3000'


class RestoreError(Exception):
    """Only fixed diagnostics may cross the deployment guard."""


def require(condition, message):
    if not condition:
        raise RestoreError(message)


def ledger(raw):
    try:
        rows = json.loads(raw)
        require(type(rows) is list and 1 <= len(rows) <= 200, 'A migration ledger is missing or invalid.')
        result = {}
        for row in rows:
            require(type(row) is dict and set(row) == {'name', 'checksum'}
                    and type(row['name']) is str and re.fullmatch(r'[0-9]{3}_[a-z0-9_]{1,120}\.sql', row['name'])
                    and type(row['checksum']) is str and re.fullmatch(r'[0-9a-f]{64}', row['checksum'])
                    and row['name'] not in result, 'A migration ledger is missing or invalid.')
            result[row['name']] = row['checksum']
        return result
    except (ValueError, TypeError, KeyError, RecursionError):
        raise RestoreError('A migration ledger is missing or invalid.') from None


def query(runner, container, database, sql):
    return runner(['docker', 'exec', '--user', 'postgres', '--env', 'PGOPTIONS=' + PGOPTIONS, container,
                   'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'pamofi_bootstrap', '-d', database, '-At', '-c', sql], timeout=20)


def capture_ledgers(runner, container):
    return {database: ledger(query(runner, container, database, LEDGER_SQL)) for database in DATABASES}


def check_subnet(runner):
    """Refuse overlapping host/Docker routes before adding the temporary bridge."""
    candidate = ipaddress.ip_network(SUBNET)
    try:
        identifiers = runner(['docker', 'network', 'ls', '--quiet', '--no-trunc']).split()
        require(len(identifiers) <= 256 and all(re.fullmatch(r'[0-9a-f]{64}', value) for value in identifiers),
                'Existing Docker networks could not be established.')
        networks = json.loads(runner(['docker', 'network', 'inspect', *identifiers])) if identifiers else []
        require(type(networks) is list and len(networks) == len(identifiers), 'Existing Docker networks could not be established.')
        for network in networks:
            for item in network.get('IPAM', {}).get('Config', []) or []:
                if item.get('Subnet'):
                    existing = ipaddress.ip_network(item['Subnet'], strict=False)
                    require(existing.version != 4 or not candidate.overlaps(existing), 'The isolated restore subnet overlaps an existing network.')
        routes = json.loads(runner(['ip', '-json', 'route', 'show', 'table', 'all']))
        require(type(routes) is list and len(routes) <= 10000, 'Host routes could not be established.')
        for route in routes:
            destination = route.get('dst')
            if destination and destination != 'default':
                existing = ipaddress.ip_network(destination, strict=False)
                require(existing.version != 4 or not candidate.overlaps(existing), 'The isolated restore subnet overlaps a host route.')
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        raise RestoreError('The isolated restore subnet could not be verified.') from None


class Resources:
    def __init__(self, runner, bucket):
        self.runner = runner
        require(type(bucket) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,254}', bucket)
                and hashlib.sha256(bucket.encode()).hexdigest() == BUCKET_SHA256,
                'The isolated restore bucket differs from the retained approved repository.')
        self.bucket = bucket
        self.token = secrets.token_hex(16)
        self.name = 'pasofi-deploy-restore-' + self.token
        self.names = {'container': {self.name + '-init', self.name + '-fetch', self.name + '-server'},
                      'volume': {self.name}, 'network': {self.name}}
        self.labels = ['--label', 'pasofi.purpose=' + PURPOSE, '--label', 'pasofi.restore.run=' + self.token]

    def inspect(self, kind, identifier):
        data = json.loads(self.runner(['docker', kind, 'inspect', identifier]))
        require(type(data) is list and len(data) == 1 and type(data[0]) is dict, 'A restore resource could not be verified.')
        row = data[0]
        name = row.get('Name', '').lstrip('/')
        labels = row.get('Config', {}).get('Labels') if kind == 'container' else row.get('Labels')
        require(name in self.names[kind] and type(labels) is dict
                and labels.get('pasofi.purpose') == PURPOSE and labels.get('pasofi.restore.run') == self.token,
                'A restore resource is not owned by this operation.')
        resource_id = row.get('Id') if kind in ('container', 'network') else name
        require(kind == 'volume' or (type(resource_id) is str and re.fullmatch(r'[0-9a-f]{64}', resource_id)),
                'A restore resource identifier is invalid.')
        return resource_id, row

    def create_container(self, suffix, image, arguments, *, connected=True, initialize=False):
        name = self.name + '-' + suffix
        argv = ['docker', 'create', '--pull=never', '--name', name, *self.labels,
                '--network', self.name if connected else 'none', '--cpus', '0.35', '--memory', '512m', '--pids-limit', '150',
                '--mount', 'type=volume,src=' + self.name + ',dst=/var/lib/postgresql/data']
        if initialize:
            argv += ['--user', 'root', '--entrypoint', '/bin/sh']
        else:
            argv += ['--tmpfs', '/run/pgbackrest:rw,noexec,nosuid,size=1m', '--env', 'PGDATA=' + PGDATA,
                     '--env', 'PGBACKREST_CONFIG=' + CONFIG, '--env', 'B2_BUCKET=' + self.bucket,
                     '--env', 'B2_REGION=eu-central-003', '--env', 'BACKUP_REPOSITORY_PREFIX=/pamofi-production',
                     '--env', 'B2_KEY_ID_FILE=/run/secrets/b2_key_id',
                     '--env', 'B2_APPLICATION_KEY_FILE=/run/secrets/b2_application_key',
                     '--env', 'BACKUP_CIPHER_FILE=/run/secrets/backup_cipher']
            for secret in ('b2_key_id', 'b2_application_key', 'backup_cipher'):
                argv += ['--mount', 'type=bind,src=' + ROOT + '/secrets/' + secret + ',dst=/run/secrets/' + secret + ',readonly']
        self.runner([*argv, image, *arguments])
        identifier, row = self.inspect('container', name)
        require(row.get('Image') == image and not row.get('HostConfig', {}).get('PortBindings'),
                'The restore container image or port isolation differs from the requested configuration.')
        return identifier

    def run_once(self, identifier, timeout):
        self.runner(['docker', 'start', '--attach', identifier], timeout=timeout)
        _, row = self.inspect('container', identifier)
        state = row.get('State', {})
        require(state.get('Running') is False and type(state.get('ExitCode')) is int and state['ExitCode'] == 0,
                'An isolated restore container did not complete successfully.')

    def owned(self, kind):
        argv = ['docker', kind, 'ls', '--filter', 'label=pasofi.restore.run=' + self.token]
        if kind == 'container':
            argv += ['--all', '--no-trunc', '--format', '{{.ID}}']
        elif kind == 'network':
            argv += ['--no-trunc', '--format', '{{.ID}}']
        else:
            argv += ['--format', '{{.Name}}']
        values = self.runner(argv).split()
        require(len(values) <= len(self.names[kind]) and len(values) == len(set(values)), 'Restore cleanup found unexpected resources.')
        return values

    def cleanup(self):
        # Discover by this unique ownership token even if a create result was
        # interrupted. Validate every name and label before deleting its ID.
        failed = False
        for kind in ('container', 'volume', 'network'):
            try:
                for resource in self.owned(kind):
                    identifier, _ = self.inspect(kind, resource)
                    argv = ['docker', kind, 'rm'] + (['--force'] if kind == 'container' else []) + [identifier]
                    self.runner(argv, timeout=60)
                require(not self.owned(kind), 'Owned restore resources remain after cleanup.')
            except Exception:
                failed = True
        require(not failed, 'Isolated restore cleanup could not be confirmed; deployment has not started.')


def restore_exact(runner, *, image, backup_label, expected_id, expected_ledgers, bucket):
    require(type(image) is str and re.fullmatch(r'sha256:[0-9a-f]{64}', image), 'An immutable restore image is required.')
    require(type(backup_label) is str and re.fullmatch(LABEL_PATTERN, backup_label), 'An exact backup label is required.')
    require(type(expected_id) is str and re.fullmatch(r'[0-9]{10,30}', expected_id), 'The retained cluster identifier is required.')
    require(type(expected_ledgers) is dict and set(expected_ledgers) == set(DATABASES), 'All five migration ledgers are required.')
    for rows in expected_ledgers.values():
        require(type(rows) is dict and ledger(json.dumps([{'name': k, 'checksum': v} for k, v in rows.items()])) == rows,
                'A reference migration ledger is invalid.')
    resources = Resources(runner, bucket)
    check_subnet(runner)
    try:
        runner(['docker', 'volume', 'create', *resources.labels, resources.name])
        resources.inspect('volume', resources.name)
        runner(['docker', 'network', 'create', '--driver', 'bridge', '--subnet', SUBNET, *resources.labels, resources.name])
        resources.inspect('network', resources.name)
        initialize = resources.create_container('init', image,
            ['-ceu', 'mkdir -p /var/lib/postgresql/data/pgdata; chown -R postgres:postgres /var/lib/postgresql/data'],
            connected=False, initialize=True)
        resources.run_once(initialize, 60)
        # Validated label is the only variable in this fixed command; restore
        # must never fall back to the repository's changing latest backup.
        restore = ('exec pgbackrest --config=' + CONFIG + ' --stanza=pamofi --repo=1 --set=' + backup_label
                   + ' --type=immediate --target-action=promote --archive-mode=off restore')
        fetch = resources.create_container('fetch', image, ['su', 'postgres', '-s', '/bin/sh', '-c', restore])
        resources.run_once(fetch, 4 * 3600)
        server = resources.create_container('server', image,
            ['postgres', '-c', 'archive_mode=off', '-c', 'listen_addresses=', '-c', 'unix_socket_permissions=0700'])
        runner(['docker', 'start', server])
        ready = False
        for attempt in range(90):
            try:
                if query(runner, server, 'postgres', 'SELECT pg_is_in_recovery()').strip() == 'f':
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(2)
        require(ready, 'The restored database did not complete recovery in time.')
        control = runner(['docker', 'exec', '--user', 'postgres', '--env', 'LC_ALL=C', server, 'pg_controldata', PGDATA])
        identifiers = re.findall(r'^Database system identifier:\s*([0-9]+)\s*$', control, flags=re.M)
        require(identifiers == [expected_id], 'The restored cluster does not match the retained production identifier.')
        require(capture_ledgers(runner, server) == expected_ledgers, 'The restored migration ledgers differ from the captured production ledgers.')
    finally:
        resources.cleanup()
    return {'status': 'passed', 'backup_label': backup_label, 'image_id': image, 'cluster_identity': 'matched',
            'migration_ledgers': 'matched_all_five', 'cleanup': 'passed', 'host_ports': 'none',
            'restore_scope': 'new_disposable_volume_on_existing_host', 'off_host_recovery_tested': False,
            'repository_bucket_sha256': BUCKET_SHA256}
