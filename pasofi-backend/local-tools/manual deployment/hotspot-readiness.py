#!/usr/bin/env python3
"""Read-only PasoFi installation inventory. Never authorizes customer activation."""
import argparse
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import shlex
import stat
import subprocess
import sys
import time

LABEL = "com.docker.compose."
HISTORICAL_ENV = Path("/home/ubuntu/pamofi/production/compose.env")
RETAINED_ID = Path("/home/ubuntu/pamofi/production/cluster-system-id")
SERVICES = ("postgres", "identity", "prepaid-access", "network", "notification", "assistant", "web",
            "gateway", "internal-gateway", "radius", "radius-api")
FLAGS = {
    "prepaid-access": ("PAMOFI_COMMERCE_ENABLED", "PAMOFI_CUSTOMER_NETWORK_ENABLED", "PAMOFI_RADIUS_QUALIFIED",
                       "PAMOFI_PAYMENTS_ENABLED", "PAMOFI_ROUTER_FLEET_ENABLED", "PAMOFI_ROUTER_FLEET_WRITE_ENABLED"),
    "network": ("PAMOFI_CUSTOMER_NETWORK_ENABLED", "PAMOFI_RADIUS_QUALIFIED", "NETWORK_RECONCILER_ENABLED",
                "ROUTER_FLEET_ENABLED", "ROUTER_FLEET_WRITES_ENABLED"),
    "notification": ("DELIVERY_WORKER_ENABLED", "SENDAI_LIVE_ENABLED", "SENDAI_QUALIFIED",
                     "INVOICE_DELIVERY_WORKER_ENABLED", "INVOICE_EMAIL_QUALIFIED", "INVOICE_SMS_QUALIFIED"),
}
SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
               "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=10",
               "-o", "ServerAliveCountMax=2", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no",
               "-o", "PermitLocalCommand=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"]
MAX_OUTPUT = 2 * 1024 * 1024
MAX_ALIASES = 4
SSH_PROBE = "PASOFI_READINESS_SSH_OK"
CONNECTION_STATUSES = {"not_configured", "configuration_unavailable", "network_unavailable",
    "authentication_failed", "host_key_untrusted", "host_key_changed", "connection_failed",
    "remote_report_invalid", "remote_collection_unavailable", "collected"}
SELECTED_STATUSES = {"remote_report_invalid", "remote_collection_unavailable", "collected"}
ERROR_CODES = {"command_unavailable", "command_timed_out", "command_output_limit", "command_failed",
               "invalid_ssh_alias", "invalid_project", "container_inventory_invalid", "project_metadata_invalid",
               "project_missing_or_ambiguous", "selected_project_not_found", "container_inventory_ambiguous",
               "remote_report_invalid", "report_directory_not_private", "invalid_arguments",
               "python_version_unavailable", "remote_output_forbidden", "connection_profile_invalid",
               "ssh_network_unavailable", "ssh_authentication_failed", "ssh_host_key_untrusted",
               "ssh_host_key_changed", "ssh_connection_failed", "ssh_configuration_unavailable",
               "connection_provenance_invalid"}
BLOCKER_CODES = ERROR_CODES | {"diagnostic_data_unavailable", "nas_registry_not_checked", "compose_stack_not_established",
    "environment_file_order_not_established", "retained_database_identity_not_verified", "physical_acceptance_not_performed",
    "ssh_or_remote_collection_unavailable"}
NEXT_INPUTS = {
    "routers": "Current inspection and local recovery access for each physical router.",
    "physical": "Controlled cash, captive login, accounting, quota, disconnect and two-site physical acceptance evidence.",
    "backups": "Current protected backup and independent restore evidence.",
    "environment": "Complete existing server environment-file paths in their original order.",
    "database": "Independently retained production database identity and its installation or backup record.",
    "project": "Working access to the existing Oracle Docker installation; select its known project when ambiguous.",
    "ssh": "Verify the existing SSH alias, trusted host record, loaded key, Python and Docker access locally.",
}
NAS_PROGRAM = """
import fs from 'node:fs'; import pg from 'pg';
const client = new pg.Client({connectionString:fs.readFileSync(process.env.DATABASE_URL_FILE,'utf8').trim(),
 connectionTimeoutMillis:3000, statement_timeout:3000});
client.on('error',()=>{});
try {
 await client.connect(); await client.query('BEGIN READ ONLY');
 const result = await client.query(`SELECT count(*)::int AS registered,
  count(*) FILTER (WHERE enabled)::int AS enabled, count(DISTINCT site_id)::int AS sites FROM radius_nas`);
 await client.query('ROLLBACK'); process.stdout.write(JSON.stringify(result.rows[0]));
} catch { process.exitCode=1; } finally { await client.end().catch(()=>{}); }
"""


class DiagnosticError(Exception):
    """Only fixed, nonsecret problem codes may leave command boundaries."""
    def __init__(self, code):
        super().__init__(code if code in ERROR_CODES else "diagnostic_data_unavailable")


def ssh_failure(stderr):
    """Classify a fixed set of OpenSSH failures without returning its raw text."""
    message = stderr.decode("utf-8", errors="replace").lower()
    if "remote host identification has changed" in message or "offending " in message and " key in " in message:
        return "ssh_host_key_changed"
    if "host key verification failed" in message or "host key is known for" in message:
        return "ssh_host_key_untrusted"
    if any(text in message for text in ("permission denied", "authentication failed", "too many authentication failures",
                                        "no more authentication methods", "unprotected private key file")):
        return "ssh_authentication_failed"
    if any(text in message for text in ("connection timed out", "operation timed out", "no route to host",
                                        "network is unreachable", "connection refused", "host is down",
                                        "could not resolve hostname", "connection reset", "connection closed")):
        return "ssh_network_unavailable"
    return "ssh_connection_failed"


def command(argv, *, payload=None, timeout=15, ssh=False):
    """Bound time and both output streams; discard stderr without echoing it."""
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={**os.environ, "LC_ALL": "C"} if ssh else None)
    except OSError:
        raise DiagnosticError("command_unavailable") from None
    output = bytearray()
    private_errors = bytearray()
    counts = {"stdout": 0, "stderr": 0}
    pending = memoryview(payload or b"")
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr")):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            if process.stdin is not None:
                os.set_blocking(process.stdin.fileno(), False)
                if pending:
                    selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
                else:
                    process.stdin.close()
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DiagnosticError("command_timed_out")
                for key, _ in selector.select(remaining):
                    if key.data == "stdin":
                        try:
                            pending = pending[os.write(key.fd, pending[:8192]):]
                        except BrokenPipeError:
                            pending = memoryview(b"")
                        if not pending:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                        continue
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    counts[key.data] += len(chunk)
                    if counts[key.data] > MAX_OUTPUT:
                        raise DiagnosticError("command_output_limit")
                    if key.data == "stdout":
                        output.extend(chunk)
                    elif ssh:
                        private_errors.extend(chunk)
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
        if process.returncode:
            raise DiagnosticError(ssh_failure(private_errors) if ssh else "command_failed")
        return output.decode("utf-8")
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        raise DiagnosticError("command_unavailable") from None
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def valid_project(value):
    return isinstance(value, str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", value) is not None


def validate_inputs(host, project):
    if host is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,252}", host):
        raise DiagnosticError("invalid_ssh_alias")
    if project is not None and not valid_project(project):
        raise DiagnosticError("invalid_project")


def validate_profile(value):
    """Profiles contain aliases only; never passwords, keys or guessed server facts."""
    try:
        if type(value) is not dict or not {"schema", "ssh_aliases"} <= set(value) <= {"schema", "ssh_aliases", "project"}:
            raise ValueError()
        aliases = value["ssh_aliases"]
        if type(value["schema"]) is not int or value["schema"] != 1 or type(aliases) is not list or not 1 <= len(aliases) <= MAX_ALIASES:
            raise ValueError()
        if any(type(alias) is not str for alias in aliases) or len(aliases) != len(set(aliases)):
            raise ValueError()
        for alias in aliases:
            validate_inputs(alias, None)
        project = value.get("project")
        if "project" in value and not valid_project(project):
            raise ValueError()
        return {"schema": 1, "ssh_aliases": list(aliases), **({"project": project} if project is not None else {})}
    except (ValueError, TypeError, DiagnosticError):
        raise DiagnosticError("connection_profile_invalid") from None


def load_profile(path):
    """Read a small regular profile without following a link or accepting extra keys."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                raise ValueError()
            raw = handle.read(4097)
            if len(raw) > 4096:
                raise ValueError()
        return validate_profile(json.loads(raw.decode("utf-8")))
    except (OSError, ValueError, UnicodeError, RecursionError):
        raise DiagnosticError("connection_profile_invalid") from None


def configured_alias(host):
    """Ask OpenSSH to resolve trusted local configuration without connecting.

    An alias with no HostName substitution is not an automatic target. This
    prevents a missing profile alias from falling through to ordinary DNS.
    OpenSSH itself handles Include, Match and its usual configuration precedence.
    The effective settings are kept in memory and never saved or printed.
    """
    validate_inputs(host, None)
    raw = command(["ssh", "-G", *SSH_OPTIONS, host], timeout=15, ssh=True)
    values = [line.split(None, 1)[1].strip() for line in raw.splitlines()
              if len(line.split(None, 1)) == 2 and line.split(None, 1)[0].lower() == "hostname"]
    if len(values) != 1:
        raise DiagnosticError("ssh_configuration_unavailable")
    hostname = values[0]
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        if not re.fullmatch(r"(?=.{1,253}\.?$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?", hostname):
            raise DiagnosticError("ssh_configuration_unavailable") from None
    return hostname.rstrip(".").lower() != host.rstrip(".").lower()


def probe_connection(host):
    """Confirm authenticated remote command access before inspecting a server."""
    remote = shlex.join(["printf", "%s\\n", SSH_PROBE])
    raw = command(["ssh", *SSH_OPTIONS, host, remote], timeout=25, ssh=True)
    if raw != SSH_PROBE + "\n":
        raise DiagnosticError("remote_report_invalid")


def incomplete_report():
    report = base_report()
    report["blockers"] = ["ssh_or_remote_collection_unavailable", "physical_acceptance_not_performed"]
    report["next_inputs"].insert(0, NEXT_INPUTS["ssh"])
    return report


def validate_connection(value):
    """Validate local connection provenance separately from the remote schema."""
    try:
        if type(value) is not dict or set(value) != {"schema", "selection", "selected_alias", "attempts"}:
            raise ValueError()
        attempts, selected = value["attempts"], value["selected_alias"]
        if type(value["schema"]) is not int or value["schema"] != 1 or value["selection"] != "automatic":
            raise ValueError()
        if type(attempts) is not list or not 1 <= len(attempts) <= MAX_ALIASES:
            raise ValueError()
        clean, seen = [], set()
        for index, attempt in enumerate(attempts):
            if type(attempt) is not dict or set(attempt) != {"alias", "status"}:
                raise ValueError()
            alias, status = attempt["alias"], attempt["status"]
            validate_inputs(alias, None)
            if type(alias) is not str or alias in seen or type(status) is not str or status not in CONNECTION_STATUSES:
                raise ValueError()
            if index < len(attempts) - 1 and status not in ("not_configured", "network_unavailable"):
                raise ValueError()
            seen.add(alias)
            clean.append({"alias": alias, "status": status})
        if selected is not None:
            validate_inputs(selected, None)
            if selected != clean[-1]["alias"] or clean[-1]["status"] not in SELECTED_STATUSES:
                raise ValueError()
        elif clean[-1]["status"] in SELECTED_STATUSES:
            raise ValueError()
        return {"schema": 1, "selection": "automatic", "selected_alias": selected, "attempts": clean}
    except (TypeError, ValueError, DiagnosticError):
        raise DiagnosticError("connection_provenance_invalid") from None


def automatic_report(profile, project=None, progress=None):
    """Use one configured server; never switch after authenticating and probing it."""
    profile = validate_profile(profile)
    project = project if project is not None else profile.get("project")
    validate_inputs(None, project)
    connection = {"schema": 1, "selection": "automatic", "selected_alias": None, "attempts": []}
    statuses = {"ssh_host_key_changed": "host_key_changed", "ssh_host_key_untrusted": "host_key_untrusted",
                "ssh_authentication_failed": "authentication_failed", "ssh_network_unavailable": "network_unavailable",
                "ssh_configuration_unavailable": "configuration_unavailable"}
    for alias in profile["ssh_aliases"]:
        attempt = {"alias": alias, "status": "connection_failed"}
        connection["attempts"].append(attempt)
        try:
            if progress is not None:
                progress(alias, "checking_configuration")
            if not configured_alias(alias):
                attempt["status"] = "not_configured"
                continue
            if progress is not None:
                progress(alias, "connecting")
            probe_connection(alias)
        except DiagnosticError as error:
            attempt["status"] = statuses.get(str(error), "connection_failed")
            if attempt["status"] == "network_unavailable":
                continue
            break
        connection["selected_alias"] = alias
        try:
            if progress is not None:
                progress(alias, "collecting")
            report = remote_report(alias, project)
            attempt["status"] = "collected"
        except (DiagnosticError, ValueError, OSError) as error:
            attempt["status"] = "remote_report_invalid" if str(error) == "remote_report_invalid" else "remote_collection_unavailable"
            report = incomplete_report()
        return report, validate_connection(connection)
    return incomplete_report(), validate_connection(connection)


def inspect_filtered(filter_value):
    ids = command(["docker", "ps", "--all", "--quiet", "--filter", "label=" + filter_value]).split()
    if len(ids) > 100 or any(not re.fullmatch(r"[0-9a-f]{12,64}", value) for value in ids):
        raise DiagnosticError("container_inventory_invalid")
    if not ids:
        return []
    rows = json.loads(command(["docker", "inspect", *ids]))
    if not isinstance(rows, list) or len(rows) != len(ids):
        raise DiagnosticError("container_inventory_invalid")
    return [row for row in rows if row.get("Config", {}).get("Labels", {}).get(LABEL + "oneoff", "false").lower() != "true"]


def environment(container):
    return dict(item.split("=", 1) for item in container.get("Config", {}).get("Env", []) if "=" in item)


def path_list(value):
    if not isinstance(value, str) or not value or len(value) > 32768:
        return None
    paths = value.split(",")
    if len(paths) > 32 or len(paths) != len(set(paths)):
        return None
    if any(not Path(path).is_absolute() or any(ord(c) < 32 for c in path) or not Path(path).is_file() for path in paths):
        return None
    return paths


def stack_metadata(rows):
    labels = [row.get("Config", {}).get("Labels", {}) for row in rows]
    directories = {label.get(LABEL + "project.working_dir", "") for label in labels}
    stacks = [path_list(label.get(LABEL + "project.config_files")) for label in labels]
    result = {"compose_files": "unresolved", "environment_files": "unresolved"}
    if len(directories) == 1:
        directory = next(iter(directories))
        if Path(directory).is_absolute() and not any(ord(c) < 32 for c in directory) and Path(directory).is_dir() and all(stacks):
            # Same ordered-superset rule as release-deploy.py; never sort overlays.
            def subsequence(older, newer):
                iterator = iter(newer)
                return all(any(item == candidate for candidate in iterator) for item in older)
            candidates = {tuple(stack) for stack in stacks if all(subsequence(other, stack) for other in stacks)}
            if len(candidates) == 1:
                result["working_directory"] = directory
                result["compose_files"] = list(candidates.pop())
    # Only report an exact, complete, consistent label. A historical file or a
    # subset of containers cannot establish the original env-file precedence.
    envs = [path_list(label.get(LABEL + "project.environment_file")) for label in labels]
    if envs and all(envs) and all(value == envs[0] for value in envs):
        result["environment_files"] = envs[0]
    result["environment_provenance"] = "consistent_container_labels" if isinstance(result["environment_files"], list) else "not_established"
    result["historical_environment_candidate"] = {
        "path": str(HISTORICAL_ENV), "present": HISTORICAL_ENV.is_file(),
        "provenance": "checked_in_onesa_install_https_operations", "complete_order_proven": False}
    return result


def database_identity(container):
    result = {"record_path": str(RETAINED_ID), "provenance": "checked_in_onesa_restore_drill_record", "status": "not_checked"}
    try:
        fd = os.open(RETAINED_ID, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 128 or info.st_mode & 0o022 or info.st_uid not in (0, os.geteuid()):
                raise ValueError()
            retained = handle.read(129).decode("ascii").strip()
            if not re.fullmatch(r"[0-9]{10,30}", retained):
                raise ValueError()
    except FileNotFoundError:
        return {**result, "status": "retained_record_missing"}
    except (OSError, ValueError, UnicodeError):
        return {**result, "status": "retained_record_unusable"}
    result["retained_system_identifier"] = retained
    if not container:
        return result
    pgdata = environment(container).get("PGDATA", "")
    if not pgdata.startswith("/var/lib/postgresql/data/") or ".." in Path(pgdata).parts or any(ord(c) < 32 for c in pgdata):
        return {**result, "status": "postgres_layout_unexpected"}
    try:
        raw = command(["docker", "exec", "--user", "postgres", "-e", "LC_ALL=C", container["Id"], "pg_controldata", pgdata])
        match = re.search(r"Database system identifier:\s*([0-9]{10,30})(?:\s|$)", raw)
        status = "match" if match and match.group(1) == retained else "mismatch" if match else "not_checked"
        return {**result, "status": status}
    except DiagnosticError:
        return result


def base_report():
    return {"schema": 1, "checked_at_utc": datetime.now(timezone.utc).isoformat(), "read_only": True,
            "customer_ready": False, "physical_checks": "not_performed", "project": None, "project_candidates": [],
            "stack": {}, "database_identity": {}, "services": [], "flags": {}, "nas_registry": {"status": "not_checked"},
            "blockers": [], "next_inputs": [NEXT_INPUTS[key] for key in ("routers", "physical", "backups")]}


def collect(project=None):
    report = base_report()
    try:
        candidates = inspect_filtered(LABEL + "service=prepaid-access")
        projects = {row.get("Config", {}).get("Labels", {}).get(LABEL + "project") for row in candidates}
        if any(not valid_project(name) for name in projects):
            raise DiagnosticError("project_metadata_invalid")
        report["project_candidates"] = sorted(projects)
        if project is None:
            if len(projects) != 1:
                raise DiagnosticError("project_missing_or_ambiguous")
            project = next(iter(projects))
        if project not in projects:
            raise DiagnosticError("selected_project_not_found")
        report["project"] = project
        rows = inspect_filtered(LABEL + "project=" + project)
        containers = {}
        for row in rows:
            labels = row.get("Config", {}).get("Labels", {})
            name = labels.get(LABEL + "service")
            if labels.get(LABEL + "project") != project or not re.fullmatch(r"[0-9a-f]{12,64}", row.get("Id", "")) or name in containers:
                raise DiagnosticError("container_inventory_ambiguous")
            containers[name] = row
        report["stack"] = stack_metadata(rows)
        report["database_identity"] = database_identity(containers.get("postgres"))
        for name in SERVICES:
            container = containers.get(name)
            if container is None:
                report["services"].append({"service": name, "state": "missing"})
                continue
            state = container.get("State", {})
            health = state.get("Health", {}).get("Status")
            revision = container.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.revision", "")
            report["services"].append({"service": name, "state": "running" if state.get("Running") is True else "stopped",
                                      "health": health if health in ("healthy", "unhealthy", "starting") else "unknown",
                                      "source_revision": revision if re.fullmatch(r"[0-9a-f]{40}", revision) else "unknown"})
        for name, keys in FLAGS.items():
            values = environment(containers.get(name, {}))
            report["flags"][name] = {key: values.get(key) == "true" if values.get(key) in ("true", "false") else "unknown" for key in keys}
        if "network" in containers:
            try:
                counts = json.loads(command(["docker", "exec", containers["network"]["Id"], "node", "--input-type=module", "-e", NAS_PROGRAM]))
                if set(counts) != {"registered", "enabled", "sites"} or any(type(value) is not int or value < 0 for value in counts.values()):
                    raise ValueError()
                report["nas_registry"] = {"status": "observed", **counts}
            except (DiagnosticError, ValueError, TypeError):
                report["blockers"].append("nas_registry_not_checked")
        if report["stack"]["compose_files"] == "unresolved":
            report["blockers"].append("compose_stack_not_established")
        if report["stack"]["environment_files"] == "unresolved":
            report["blockers"].append("environment_file_order_not_established")
            report["next_inputs"].append(NEXT_INPUTS["environment"])
        if report["database_identity"]["status"] != "match":
            report["blockers"].append("retained_database_identity_not_verified")
            report["next_inputs"].append(NEXT_INPUTS["database"])
    except DiagnosticError as error:
        report["blockers"].append(str(error))
        report["next_inputs"].append(NEXT_INPUTS["project"])
    except Exception:
        report["blockers"].append("diagnostic_data_unavailable")
    report["blockers"].append("physical_acceptance_not_performed")
    return report


def validate_report(value, selected_project=None):
    """Project the entire remote schema; never consult remote paths on the Mac."""
    def require(condition):
        if not condition:
            raise DiagnosticError("remote_report_invalid")

    def keys(item, required, optional=()):
        require(type(item) is dict and set(required) <= set(item) <= set(required) | set(optional))

    def choice(item, allowed):
        require(type(item) is str and item in allowed)
        return item

    def path(item):
        require(type(item) is str and 1 < len(item) <= 4096 and item.startswith("/") and not item.startswith("//")
                and all(c.isprintable() for c in item) and not {".", ".."}.intersection(item.split("/"))
                and PurePosixPath(item).is_absolute())
        return item

    def paths(item):
        if item == "unresolved":
            return "unresolved"
        require(type(item) is list and 1 <= len(item) <= 32)
        result = [path(entry) for entry in item]
        require(len(result) == len(set(result)) and sum(map(len, result)) <= 32768)
        return result

    def known_list(item, allowed):
        require(type(item) is list and len(item) <= len(allowed))
        result = [choice(entry, allowed) for entry in item]
        require(len(result) == len(set(result)))
        return result

    try:
        keys(value, base_report())
        require(type(value["schema"]) is int and value["schema"] == 1 and value["read_only"] is True
                and value["customer_ready"] is False and value["physical_checks"] == "not_performed")
        checked = value["checked_at_utc"]
        require(type(checked) is str and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?\+00:00", checked))
        datetime.fromisoformat(checked)
        project = value["project"]
        require(project is None or valid_project(project))
        require(project is None or selected_project is None or project == selected_project)
        candidates = value["project_candidates"]
        require(type(candidates) is list and len(candidates) <= 100 and all(valid_project(name) for name in candidates))
        require(len(candidates) == len(set(candidates)) and (project is None or project in candidates))
        result = base_report()
        result.update(checked_at_utc=checked, project=project, project_candidates=list(candidates),
                      blockers=known_list(value["blockers"], BLOCKER_CODES),
                      next_inputs=known_list(value["next_inputs"], set(NEXT_INPUTS.values())))

        stack = value["stack"]
        require(type(stack) is dict)
        if stack:
            keys(stack, ("compose_files", "environment_files", "environment_provenance", "historical_environment_candidate"), ("working_directory",))
            compose, env = paths(stack["compose_files"]), paths(stack["environment_files"])
            require(("working_directory" in stack) == isinstance(compose, list))
            provenance = "consistent_container_labels" if isinstance(env, list) else "not_established"
            require(stack["environment_provenance"] == provenance)
            historical = stack["historical_environment_candidate"]
            keys(historical, ("path", "present", "provenance", "complete_order_proven"))
            require(historical["path"] == str(HISTORICAL_ENV) and type(historical["present"]) is bool
                    and historical["provenance"] == "checked_in_onesa_install_https_operations" and historical["complete_order_proven"] is False)
            result["stack"] = {"compose_files": compose, "environment_files": env, "environment_provenance": provenance,
                "historical_environment_candidate": {"path": str(HISTORICAL_ENV), "present": historical["present"],
                    "provenance": "checked_in_onesa_install_https_operations", "complete_order_proven": False}}
            if isinstance(compose, list):
                result["stack"]["working_directory"] = path(stack["working_directory"])

        database = value["database_identity"]
        require(type(database) is dict)
        if database:
            keys(database, ("record_path", "provenance", "status"), ("retained_system_identifier",))
            status = choice(database["status"], {"not_checked", "retained_record_missing", "retained_record_unusable", "postgres_layout_unexpected", "match", "mismatch"})
            require(database["record_path"] == str(RETAINED_ID) and database["provenance"] == "checked_in_onesa_restore_drill_record")
            require(("retained_system_identifier" in database) == (status not in ("retained_record_missing", "retained_record_unusable")))
            result["database_identity"] = {"record_path": str(RETAINED_ID), "provenance": "checked_in_onesa_restore_drill_record", "status": status}
            if "retained_system_identifier" in database:
                identifier = database["retained_system_identifier"]
                require(type(identifier) is str and re.fullmatch(r"[0-9]{10,30}", identifier))
                result["database_identity"]["retained_system_identifier"] = identifier

        services = value["services"]
        require(type(services) is list and len(services) <= len(SERVICES))
        seen = set()
        for service in services:
            keys(service, ("service", "state"), ("health", "source_revision"))
            name, state = choice(service["service"], SERVICES), choice(service["state"], {"missing", "running", "stopped"})
            require(name not in seen)
            seen.add(name)
            projected = {"service": name, "state": state}
            require(set(service) == ({"service", "state"} if state == "missing" else {"service", "state", "health", "source_revision"}))
            if state != "missing":
                revision = service["source_revision"]
                require(type(revision) is str and (revision == "unknown" or re.fullmatch(r"[0-9a-f]{40}", revision)))
                projected.update(health=choice(service["health"], {"unknown", "healthy", "unhealthy", "starting"}), source_revision=revision)
            result["services"].append(projected)

        flags = value["flags"]
        require(type(flags) is dict and set(flags) <= set(FLAGS))
        for name, gates in flags.items():
            keys(gates, FLAGS[name])
            require(all(type(item) is bool or (type(item) is str and item == "unknown") for item in gates.values()))
            result["flags"][name] = {key: gates[key] for key in FLAGS[name]}
        nas = value["nas_registry"]
        keys(nas, ("status",), ("registered", "enabled", "sites"))
        status = choice(nas["status"], {"not_checked", "observed"})
        require(set(nas) == ({"status"} if status == "not_checked" else {"status", "registered", "enabled", "sites"}))
        if status == "observed":
            require(all(type(nas[key]) is int and 0 <= nas[key] <= 2147483647 for key in ("registered", "enabled", "sites")))
            require(nas["enabled"] <= nas["registered"] and nas["sites"] <= nas["registered"])
            result["nas_registry"] = {"status": status, **{key: nas[key] for key in ("registered", "enabled", "sites")}}
        require(project is not None or not any((result["stack"], result["database_identity"], result["services"], result["flags"], status == "observed")))
        return result
    except (KeyError, TypeError, ValueError, RecursionError):
        raise DiagnosticError("remote_report_invalid") from None


def remote_report(host, project=None):
    validate_inputs(host, project)
    # Standard library only: ignore Python environment hooks and avoid creating
    # remote bytecode caches while the fixed collector is streamed on stdin.
    remote = ["python3", "-I", "-B", "-S", "-", "--remote", *(["--project", project] if project else [])]
    source = Path(__file__).read_bytes()
    raw = command(["ssh", *SSH_OPTIONS, host, shlex.join(remote)], payload=source, timeout=150)
    try:
        return validate_report(json.loads(raw), project)
    except (ValueError, RecursionError):
        raise DiagnosticError("remote_report_invalid") from None


def save_report(report, output=None, connection=None):
    report = validate_report(report)
    if connection is not None:
        # This field is created by the Mac after validation. The remote is not
        # allowed to supply, spoof or extend local connection provenance.
        report["connection"] = validate_connection(connection)
    if output is None:
        directory = Path.cwd() / "PasoFi_Readiness"
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise DiagnosticError("report_directory_not_private")
        output = directory / ("readiness-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
    path = Path(output).absolute()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    return path


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise DiagnosticError("invalid_arguments")


def main(argv=None):
    parser = Parser(description="Collect a private read-only PasoFi readiness report through an existing SSH alias.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--host", help="Existing SSH alias with a trusted host record and available key")
    mode.add_argument("--auto", action="store_true", help="Use the packaged connection profile automatically (default)")
    mode.add_argument("--remote", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--profile", help="Connection profile; default: mac-connection.json beside this script")
    parser.add_argument("--project", help="Existing Compose project, only when needed to resolve ambiguity")
    parser.add_argument("--output", help="New local JSON file; default: a private PasoFi_Readiness folder")
    try:
        args = parser.parse_args(argv)
        if sys.version_info < (3, 9):
            raise DiagnosticError("python_version_unavailable")
        validate_inputs(args.host, args.project)
        if args.remote:
            if args.output or args.profile:
                raise DiagnosticError("remote_output_forbidden")
            print(json.dumps(collect(args.project)))
            return 0
        connection = None
        if args.host:
            if args.profile:
                raise DiagnosticError("invalid_arguments")
            try:
                report = remote_report(args.host, args.project)
            except (DiagnosticError, ValueError, OSError):
                report = incomplete_report()
        else:
            profile = load_profile(args.profile or Path(__file__).with_name("mac-connection.json"))
            labels = {"checking_configuration": "Checking configured SSH alias", "connecting": "Checking secure connection",
                      "collecting": "Reading the existing PasoFi installation"}
            report, connection = automatic_report(profile, args.project,
                progress=lambda alias, stage: print(labels[stage] + ": " + alias, flush=True))
            for attempt in connection["attempts"]:
                print("Connection " + attempt["alias"] + ": " + attempt["status"])
        path = save_report(report, args.output, connection=connection)
        print("Private read-only report saved: " + str(path))
        if report["project"]:
            print("Existing Compose project: " + report["project"])
        print("No deployment or customer activation was performed. Physical and cash acceptance remain required.")
        return 1 if "ssh_or_remote_collection_unavailable" in report["blockers"] else 0
    except (DiagnosticError, OSError):
        print("Readiness collection stopped. Check the documented arguments, tools and private output location; no diagnostic output was disclosed.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
