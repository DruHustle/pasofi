#!/usr/bin/env python3
"""Bounded, read-only server checks after a pinned PasoFi application deployment."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import stat
import subprocess
import sys
import time

APPS = ("identity", "prepaid-access", "network", "notification", "assistant")
RELEASE_SERVICES = (*APPS, "web")
SERVICES = ("postgres", *RELEASE_SERVICES, "gateway", "internal-gateway", "radius", "radius-api")
REQUIRED = set(SERVICES) - {"radius", "radius-api"}
HEALTH_REQUIRED = {"postgres", *RELEASE_SERVICES, "radius-api"}
LABEL = "com.docker.compose."
RETAINED_ID = Path("/home/ubuntu/pamofi/production/cluster-system-id")
FLAGS = {
    "prepaid-access": ("PAMOFI_COMMERCE_ENABLED", "PAMOFI_CUSTOMER_NETWORK_ENABLED", "PAMOFI_RADIUS_QUALIFIED",
                       "PAMOFI_PAYMENTS_ENABLED", "PAMOFI_ROUTER_FLEET_ENABLED", "PAMOFI_ROUTER_FLEET_WRITE_ENABLED"),
    "network": ("PAMOFI_CUSTOMER_NETWORK_ENABLED", "PAMOFI_RADIUS_QUALIFIED", "NETWORK_RECONCILER_ENABLED",
                "ROUTER_FLEET_ENABLED", "ROUTER_FLEET_WRITES_ENABLED"),
    "notification": ("DELIVERY_WORKER_ENABLED", "SENDAI_LIVE_ENABLED", "SENDAI_QUALIFIED",
                     "INVOICE_DELIVERY_WORKER_ENABLED", "INVOICE_EMAIL_QUALIFIED", "INVOICE_SMS_QUALIFIED"),
}
TIMER_SERVICES = {
    "pamofi-backup-full.timer": "pamofi-backup@full.service",
    "pamofi-backup-diff.timer": "pamofi-backup@diff.service",
    "pamofi-backup-check.timer": "pamofi-backup@check.service",
    "pamofi-restore-drill.timer": "pamofi-restore-drill.service",
    "pamofi-radius-ensure.timer": "pamofi-radius-ensure.service",
}
QUEUE_QUERIES = {
    "prepaid-access": """SELECT
      (SELECT count(*)::int FROM event_outbox WHERE status='dead') AS outbox_dead,
      (SELECT count(*)::int FROM event_outbox WHERE status='pending' AND next_at<now()-interval '5 minutes') AS outbox_delayed,
      (SELECT count(*)::int FROM payment_reconciliation_jobs WHERE state='dead') AS payment_verification_dead,
      (SELECT count(*)::int FROM provider_payment_attempts WHERE state IN ('unknown','review')) AS payment_review,
      (SELECT count(*)::int FROM network_account_holds) AS account_holds,
      (SELECT count(*)::int FROM access_grants WHERE state='uncertain' OR (state IN ('pending','active') AND COALESCE(last_accounting_at,issued_at)<now()-interval '3 minutes')) AS network_review""",
    "notification": """SELECT
      (SELECT count(*)::int FROM delivery_jobs WHERE state='unknown') AS sms_ambiguous,
      (SELECT count(*)::int FROM delivery_jobs WHERE state='failed') AS sms_failed,
      (SELECT count(*)::int FROM delivery_jobs WHERE state IN ('awaiting_delivery_details','ready','submitted') AND next_at<now()-interval '5 minutes') AS sms_delayed,
      (SELECT count(*)::int FROM invoice_jobs WHERE state='unknown') AS invoice_ambiguous,
      (SELECT count(*)::int FROM invoice_jobs WHERE state='failed') AS invoice_failed,
      (SELECT count(*)::int FROM invoice_jobs WHERE state IN ('queued','submitting','submitted') AND created_at<now()-interval '15 minutes') AS invoice_delayed""",
    "network": """SELECT
      (SELECT count(*)::int FROM router_reconciliation_status WHERE result='unavailable') AS router_unavailable,
      (SELECT count(*)::int FROM router_reconciliation_status WHERE result='present') AS router_absence_unconfirmed""",
}
QUEUE_FIELDS = {
    "prepaid-access": ("outbox_dead", "outbox_delayed", "payment_verification_dead", "payment_review", "account_holds", "network_review"),
    "notification": ("sms_ambiguous", "sms_failed", "sms_delayed", "invoice_ambiguous", "invoice_failed", "invoice_delayed"),
    "network": ("router_unavailable", "router_absence_unconfirmed"),
}
SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
               "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=10",
               "-o", "ServerAliveCountMax=2", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no",
               "-o", "PermitLocalCommand=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"]
MAX_OUTPUT = 2 * 1024 * 1024
MAX_INPUT = 128 * 1024
ERRORS = {"invalid_arguments", "command_unavailable", "command_failed", "command_timed_out", "command_output_limit",
          "inventory_unavailable", "invalid_report", "postcheck_unavailable"}
PROBLEMS = {"inventory_unavailable", "required_service_not_healthy", "runtime_revision_not_verified",
            "database_identity_not_verified", "application_http_not_verified", "internal_gateway_not_verified",
            "queues_not_verified", "queue_attention_required", "migrations_not_verified", "baseline_flags_changed",
            "baseline_flags_not_fully_verified", "timer_observation_incomplete"}


class PostcheckError(Exception):
    def __init__(self, code):
        super().__init__(code if code in ERRORS else "postcheck_unavailable")


def require(condition, code="invalid_report"):
    if not condition:
        raise PostcheckError(code)


def command(argv, *, payload=None, timeout=15):
    """Bound both output streams and elapsed time; never print raw command errors."""
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        raise PostcheckError("command_unavailable") from None
    output = bytearray()
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
                    raise PostcheckError("command_timed_out")
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
                        raise PostcheckError("command_output_limit")
                    if key.data == "stdout":
                        output.extend(chunk)
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
        if process.returncode:
            raise PostcheckError("command_failed")
        return output.decode("utf-8")
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        raise PostcheckError("command_unavailable") from None
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def valid_project(value):
    return type(value) is str and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", value) is not None


def valid_commit(value):
    return type(value) is str and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def validate_inputs(project, expected_commit, expected_database_id, expected_migrations=None, baseline_flags=None):
    require(valid_project(project) and valid_commit(expected_commit), "invalid_arguments")
    require(type(expected_database_id) is str and re.fullmatch(r"[0-9]{10,30}", expected_database_id), "invalid_arguments")
    if expected_migrations is not None:
        require(type(expected_migrations) is dict and set(expected_migrations) <= set(APPS), "invalid_arguments")
        for names in expected_migrations.values():
            require(type(names) is dict and 1 <= len(names) <= 200, "invalid_arguments")
            require(all(type(name) is str and re.fullmatch(r"[0-9]{3}_[a-z0-9_]{1,120}\.sql", name)
                        and type(checksum) is str and re.fullmatch(r"[0-9a-f]{64}", checksum)
                        for name, checksum in names.items()), "invalid_arguments")
        require(len(json.dumps(expected_migrations)) <= MAX_INPUT, "invalid_arguments")
    if baseline_flags is not None:
        require(type(baseline_flags) is dict and set(baseline_flags) <= set(FLAGS), "invalid_arguments")
        for service, gates in baseline_flags.items():
            require(type(gates) is dict and set(gates) == set(FLAGS[service]), "invalid_arguments")
            require(all(type(value) is bool or (type(value) is str and value == "unknown") for value in gates.values()), "invalid_arguments")


def inspect_project(project):
    ids = command(["docker", "ps", "--all", "--quiet", "--filter", "label=" + LABEL + "project=" + project]).split()
    require(0 < len(ids) <= 100 and len(ids) == len(set(ids))
            and all(re.fullmatch(r"[0-9a-f]{12,64}", item) for item in ids), "inventory_unavailable")
    rows = json.loads(command(["docker", "inspect", *ids]))
    require(type(rows) is list and len(rows) == len(ids), "inventory_unavailable")
    containers = {}
    for row in rows:
        require(type(row) is dict and type(row.get("Config")) is dict, "inventory_unavailable")
        labels = row["Config"].get("Labels", {})
        require(type(labels) is dict and labels.get(LABEL + "project") == project, "inventory_unavailable")
        oneoff = labels.get(LABEL + "oneoff", "false")
        require(type(oneoff) is str and oneoff.lower() in ("true", "false"), "inventory_unavailable")
        if oneoff.lower() == "true":
            continue
        name = labels.get(LABEL + "service")
        require(type(name) is str and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,99}", name)
                and name not in containers and type(row.get("Id")) is str
                and re.fullmatch(r"[0-9a-f]{12,64}", row["Id"]), "inventory_unavailable")
        containers[name] = row
    return containers


def environment(container):
    values = container.get("Config", {}).get("Env", [])
    require(type(values) is list and len(values) <= 1000
            and all(type(value) is str and len(value) <= 32768 for value in values), "inventory_unavailable")
    result = {}
    for entry in values:
        if "=" in entry:
            key, value = entry.split("=", 1)
            require(key not in result, "inventory_unavailable")
            result[key] = value
    return result


def image_revisions(containers):
    images = {row.get("Image") for name, row in containers.items() if name in RELEASE_SERVICES}
    if not images or any(type(value) is not str or not re.fullmatch(r"sha256:[0-9a-f]{64}", value) for value in images):
        return {}
    rows = json.loads(command(["docker", "image", "inspect", *sorted(images)]))
    require(type(rows) is list and len(rows) == len(images), "inventory_unavailable")
    result = {}
    for row in rows:
        require(type(row) is dict and row.get("Id") in images and row["Id"] not in result, "inventory_unavailable")
        revision = row.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.revision")
        result[row["Id"]] = revision if valid_commit(revision) else None
    return result


def retained_record(expected):
    try:
        fd = os.open(RETAINED_ID, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 128 or info.st_mode & 0o022 or info.st_uid not in (0, os.geteuid()):
                return "unusable"
            value = handle.read(129).decode("ascii").strip()
            if not re.fullmatch(r"[0-9]{10,30}", value):
                return "unusable"
            return "match" if value == expected else "mismatch"
    except FileNotFoundError:
        return "missing"
    except (OSError, UnicodeError):
        return "unusable"


def check_database(container, expected):
    result = {"retained_record": retained_record(expected), "live_cluster": "not_checked"}
    if container is None:
        return result
    try:
        pgdata = environment(container).get("PGDATA", "")
        require(pgdata.startswith("/var/lib/postgresql/data/") and len(pgdata) < 4096
                and not {".", ".."}.intersection(pgdata.split("/")) and all(c.isprintable() for c in pgdata))
        raw = command(["docker", "exec", "--user", "postgres", "-e", "LC_ALL=C", container["Id"], "pg_controldata", pgdata])
        match = re.search(r"^Database system identifier:\s*([0-9]{10,30})\s*$", raw, re.M)
        if match:
            result["live_cluster"] = "match" if match.group(1) == expected else "mismatch"
    except (PostcheckError, ValueError, TypeError, KeyError):
        pass
    return result


def database_program(body):
    return """
import fs from 'node:fs'; import pg from 'pg';
const client=new pg.Client({connectionString:fs.readFileSync(process.env.DATABASE_URL_FILE,'utf8').trim(),connectionTimeoutMillis:3000,statement_timeout:3000});
client.on('error',()=>{});
try { await client.connect(); await client.query('BEGIN READ ONLY');
""" + body + """
await client.query('ROLLBACK');
} catch { process.exitCode=1; } finally { await client.end().catch(()=>{}); }
"""


def aggregate(container, service):
    program = database_program("const result=await client.query(" + json.dumps(QUEUE_QUERIES[service]) + ");process.stdout.write(JSON.stringify(result.rows[0]));")
    result = json.loads(command(["docker", "exec", container["Id"], "node", "--input-type=module", "-e", program]))
    require(type(result) is dict and set(result) == set(QUEUE_FIELDS[service])
            and all(type(value) is int and 0 <= value <= 2147483647 for value in result.values()))
    return {"status": "observed", "counts": {key: result[key] for key in QUEUE_FIELDS[service]}}


def migration_check(container, expected):
    program = database_program("""
const expected=""" + json.dumps(expected, separators=(",", ":")) + """;
const rows=(await client.query('SELECT name,checksum FROM schema_migrations ORDER BY name LIMIT 1001')).rows;
if(rows.length>1000 || rows.some(row=>typeof row.name!=='string'||!/^\\d{3}_[a-z0-9_]{1,120}\\.sql$/.test(row.name)||typeof row.checksum!=='string'||!/^[0-9a-f]{64}$/.test(row.checksum))) throw Error();
const actual=new Map(rows.map(row=>[row.name,row.checksum])); if(actual.size!==rows.length) throw Error();
const missing=Object.keys(expected).filter(name=>!actual.has(name)).length;
const changed=Object.entries(expected).filter(([name,sum])=>actual.has(name)&&actual.get(name)!==sum).length;
const unexpected=rows.filter(row=>!Object.hasOwn(expected,row.name)).length;
process.stdout.write(JSON.stringify({expected:Object.keys(expected).length,applied:rows.length,missing,changed,unexpected}));
""")
    result = json.loads(command(["docker", "exec", container["Id"], "node", "--input-type=module", "-e", program]))
    require(type(result) is dict and set(result) == {"expected", "applied", "missing", "changed", "unexpected"}
            and all(type(value) is int and 0 <= value <= 1000 for value in result.values()))
    require(result["expected"] == len(expected) and result["missing"] <= result["expected"]
            and result["changed"] <= result["expected"] - result["missing"]
            and result["applied"] == result["expected"] - result["missing"] + result["unexpected"])
    return {"status": "match" if not any(result[key] for key in ("missing", "changed", "unexpected")) else "mismatch", **result}


def http_program(checks):
    # All URLs/check names come from fixed source below, never the report or user.
    return """
const checks=""" + json.dumps(checks, separators=(",", ":")) + """; const result={};
for(const [name,url,status,kind,expected] of checks){
 let response;
 try{
  response=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(3000)});
  if(response.status!==status||response.headers.has('set-cookie'))throw Error();
  if(kind==='json'){
   if(!/^application\\/json(?:\\s*;|$)/i.test(response.headers.get('content-type')||''))throw Error();
   const reader=response.body?.getReader(); if(!reader)throw Error(); let size=0,parts=[];
   try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>4096)throw Error();parts.push(item.value);}}finally{await reader.cancel().catch(()=>{});}
   const data=JSON.parse(Buffer.concat(parts).toString('utf8'));
   if(!data||typeof data!=='object'||Array.isArray(data))throw Error();
   if(expected && (Object.keys(data).length!==Object.keys(expected).length || Object.entries(expected).some(([key,value])=>data[key]!==value)))throw Error();
  } else if(kind==='html'&&!/^text\\/html(?:\\s*;|$)/i.test(response.headers.get('content-type')||''))throw Error();
  result[name]='passed';
 }catch{result[name]='unavailable';}finally{if(response&&!response.bodyUsed)await response.body?.cancel().catch(()=>{});}
}
process.stdout.write(JSON.stringify(result));
"""


def http_checks(container, checks):
    result = json.loads(command(["docker", "exec", container["Id"], "node", "--input-type=module", "-e", http_program(checks)], timeout=20))
    require(type(result) is dict and set(result) == {check[0] for check in checks}
            and all(value in ("passed", "unavailable") for value in result.values()))
    return result


def timer_check(timer):
    result = {"timer": timer, "load": "unknown", "active": "unknown", "enabled": "unknown",
              "last_run": "unavailable", "qualification": "status_only"}
    try:
        props = "LoadState,ActiveState,UnitFileState,Result,ExecMainCode,ExecMainStatus,ExecMainExitTimestampMonotonic"
        def read(unit):
            raw = command(["systemctl", "show", "--no-pager", "--property=" + props, unit], timeout=8)
            values = {}
            for line in raw.splitlines():
                key, sep, value = line.partition("=")
                require(sep and key in props.split(",") and key not in values)
                values[key] = value
            require(set(values) <= set(props.split(",")))
            return values
        status = read(timer)
        for field, prop, allowed in (
            ("load", "LoadState", {"loaded", "not-found", "masked", "error"}),
            ("active", "ActiveState", {"active", "inactive", "failed", "activating", "deactivating"}),
            ("enabled", "UnitFileState", {"enabled", "enabled-runtime", "disabled", "static", "masked", "indirect"}),
        ):
            if status.get(prop) in allowed:
                result[field] = status[prop]
        if result["load"] != "loaded":
            return result
        previous = read(TIMER_SERVICES[timer])
        if previous.get("ActiveState") == "activating":
            result["last_run"] = "running"
        elif re.fullmatch(r"[0-9]{1,20}", previous.get("ExecMainExitTimestampMonotonic", "")):
            if int(previous["ExecMainExitTimestampMonotonic"]) == 0:
                result["last_run"] = "not_run"
            elif previous.get("Result") == "success" and previous.get("ExecMainCode") == "1" and previous.get("ExecMainStatus") == "0":
                result["last_run"] = "succeeded"
            else:
                result["last_run"] = "failed"
    except (PostcheckError, ValueError, TypeError):
        pass
    return result


def base_report(project, expected_commit):
    return {"schema": 1, "checked_at_utc": datetime.now(timezone.utc).isoformat(), "read_only": True,
            "project": project, "expected_commit": expected_commit, "customer_ready": False,
            "physical_checks": "not_performed", "services": [], "database_identity": {"retained_record": "unusable", "live_cluster": "not_checked"},
            "flags": {}, "baseline_flags": {"status": "not_checked", "checked_fields": 0, "unverified_fields": 0},
            "application_http": {name: {"live": "unavailable", "ready": "unavailable"} for name in APPS},
            "internal_http": {name: "unavailable" for name in ("identity_auth", "unknown_route", "web")},
            "queues": {name: {"status": "not_checked"} for name in QUEUE_FIELDS},
            "migrations": {name: {"status": "not_checked"} for name in APPS},
            "timers": [], "problems": [], "software_checks_passed": False}


def problem_codes(report):
    """Derive conclusions from observations instead of trusting supplied success bits."""
    problems = set()
    services = {item["service"]: item for item in report["services"]}
    if not REQUIRED <= set(services) or any(
        (name in REQUIRED or row["state"] != "missing") and
        (row["state"] != "running" or (name in HEALTH_REQUIRED and row["health"] != "healthy"))
        for name, row in services.items()
    ):
        problems.add("required_service_not_healthy")
    if any(services.get(name, {}).get("revision") != "match" for name in RELEASE_SERVICES):
        problems.add("runtime_revision_not_verified")
    if any(value != "match" for value in report["database_identity"].values()):
        problems.add("database_identity_not_verified")
    if any(value != "passed" for item in report["application_http"].values() for value in item.values()):
        problems.add("application_http_not_verified")
    if any(value != "passed" for value in report["internal_http"].values()):
        problems.add("internal_gateway_not_verified")
    if any(item["status"] != "observed" for item in report["queues"].values()):
        problems.add("queues_not_verified")
    if any(any(item.get("counts", {}).values()) for item in report["queues"].values()):
        problems.add("queue_attention_required")
    if any(item["status"] != "match" for item in report["migrations"].values()):
        problems.add("migrations_not_verified")
    if report["baseline_flags"]["status"] == "changed":
        problems.add("baseline_flags_changed")
    elif report["baseline_flags"]["status"] != "unchanged":
        problems.add("baseline_flags_not_fully_verified")
    if any(item["load"] != "loaded" or item["active"] != "active" or item["enabled"] not in ("enabled", "enabled-runtime")
           or item["last_run"] not in ("succeeded", "running") for item in report["timers"]):
        problems.add("timer_observation_incomplete")
    return problems


def collect(project, expected_commit, expected_database_id, *, expected_migrations=None, baseline_flags=None):
    validate_inputs(project, expected_commit, expected_database_id, expected_migrations, baseline_flags)
    report = base_report(project, expected_commit)
    problems = set()
    try:
        containers = inspect_project(project)
        try:
            revisions = image_revisions(containers)
        except (PostcheckError, ValueError, KeyError, TypeError, AttributeError):
            revisions = {}
        for service in SERVICES:
            container = containers.get(service)
            state = container.get("State", {}) if container else {}
            health = state.get("Health", {}).get("Status")
            running = state.get("Running") is True
            row = {"service": service, "state": "running" if running else "stopped" if container else "missing",
                   "health": health if health in ("healthy", "unhealthy", "starting") else "not_configured",
                   "revision": "not_applicable"}
            if service in RELEASE_SERVICES:
                revision = revisions.get(container.get("Image")) if container else None
                row["revision"] = "match" if revision == expected_commit else "mismatch" if revision else "unverified"
                if row["revision"] != "match":
                    problems.add("runtime_revision_not_verified")
            if (service in REQUIRED or container) and (not running or (service in HEALTH_REQUIRED and health != "healthy")):
                problems.add("required_service_not_healthy")
            report["services"].append(row)
        report["database_identity"] = check_database(containers.get("postgres"), expected_database_id)
        if any(value != "match" for value in report["database_identity"].values()):
            problems.add("database_identity_not_verified")
        for service, fields in FLAGS.items():
            env = environment(containers.get(service, {}))
            report["flags"][service] = {key: env.get(key) == "true" if env.get(key) in ("true", "false") else "unknown" for key in fields}
        if baseline_flags:
            checked, unverified, changed = 0, 0, False
            for service, fields in baseline_flags.items():
                for key, previous in fields.items():
                    current = report["flags"][service][key]
                    if type(previous) is bool and type(current) is bool:
                        checked += 1
                    else:
                        unverified += 1
                    changed |= current != previous
            # Equality of two unknown observations preserves that uncertainty;
            # it does not establish a provider's qualification or infer false.
            report["baseline_flags"] = {"status": "changed" if changed else "unchanged" if checked + unverified else "not_checked",
                                        "checked_fields": checked, "unverified_fields": unverified}
        if report["baseline_flags"]["status"] == "changed":
            problems.add("baseline_flags_changed")
        elif report["baseline_flags"]["status"] != "unchanged":
            problems.add("baseline_flags_not_fully_verified")
        for service in APPS:
            container = containers.get(service)
            if not container:
                continue
            try:
                report["application_http"][service] = http_checks(container, [
                    ["live", "http://127.0.0.1:3000/health/live", 200, "json", {"status": "ok", "service": service}],
                    ["ready", "http://127.0.0.1:3000/health/ready", 200, "json", {"status": "ready"}],
                ])
            except (PostcheckError, ValueError, TypeError, KeyError):
                pass
            if expected_migrations and service in expected_migrations:
                try:
                    report["migrations"][service] = migration_check(container, expected_migrations[service])
                except (PostcheckError, ValueError, TypeError, KeyError):
                    pass
        if any(value != "passed" for item in report["application_http"].values() for value in item.values()):
            problems.add("application_http_not_verified")
        if any(item["status"] != "match" for item in report["migrations"].values()):
            problems.add("migrations_not_verified")
        if containers.get("prepaid-access"):
            try:
                report["internal_http"] = http_checks(containers["prepaid-access"], [
                    ["identity_auth", "https://identity.internal/internal/v1/session", 401, "json", {"error": "unauthorized"}],
                    ["unknown_route", "https://identity.internal/postcheck-unknown", 404, "status", None],
                    ["web", "http://web/", 200, "html", None],
                ])
            except (PostcheckError, ValueError, TypeError, KeyError):
                pass
        if any(value != "passed" for value in report["internal_http"].values()):
            problems.add("internal_gateway_not_verified")
        for service in QUEUE_FIELDS:
            if containers.get(service):
                try:
                    report["queues"][service] = aggregate(containers[service], service)
                except (PostcheckError, ValueError, TypeError, KeyError):
                    pass
            if report["queues"][service]["status"] != "observed":
                problems.add("queues_not_verified")
            elif any(report["queues"][service]["counts"].values()):
                problems.add("queue_attention_required")
    except (PostcheckError, ValueError, TypeError, KeyError, AttributeError):
        problems.add("inventory_unavailable")
    report["timers"] = [timer_check(timer) for timer in TIMER_SERVICES]
    problems = problem_codes(report) | (problems & {"inventory_unavailable"})
    report["problems"] = sorted(problems)
    report["software_checks_passed"] = not problems
    return validate_report(report, project, expected_commit)


def validate_report(value, project=None, expected_commit=None):
    """Reconstruct every nested field; no raw metadata, command output or rows survive."""
    def keys(item, expected):
        require(type(item) is dict and set(item) == set(expected))
    def enum(item, allowed):
        require(type(item) is str and item in allowed)
        return item
    def count(item, maximum=2147483647):
        require(type(item) is int and 0 <= item <= maximum)
        return item
    try:
        keys(value, base_report("", ""))
        require(type(value["schema"]) is int and value["schema"] == 1 and value["read_only"] is True
                and value["customer_ready"] is False and value["physical_checks"] == "not_performed")
        require(valid_project(value["project"]) and (project is None or value["project"] == project))
        require(valid_commit(value["expected_commit"]) and (expected_commit is None or value["expected_commit"] == expected_commit))
        checked = value["checked_at_utc"]
        require(type(checked) is str and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?\+00:00", checked))
        datetime.fromisoformat(checked)
        result = base_report(value["project"], value["expected_commit"])
        result["checked_at_utc"] = checked
        services = value["services"]
        require(type(services) is list and len(services) <= len(SERVICES))
        names = set()
        for row in services:
            keys(row, ("service", "state", "health", "revision"))
            service = enum(row["service"], SERVICES)
            require(service not in names)
            names.add(service)
            revision = enum(row["revision"], {"match", "mismatch", "unverified"} if service in RELEASE_SERVICES else {"not_applicable"})
            result["services"].append({"service": service, "state": enum(row["state"], {"running", "stopped", "missing"}),
                "health": enum(row["health"], {"healthy", "unhealthy", "starting", "not_configured"}), "revision": revision})
        identity = value["database_identity"]
        keys(identity, ("retained_record", "live_cluster"))
        result["database_identity"] = {"retained_record": enum(identity["retained_record"], {"match", "mismatch", "missing", "unusable"}),
                                       "live_cluster": enum(identity["live_cluster"], {"match", "mismatch", "not_checked"})}
        flags = value["flags"]
        require(type(flags) is dict and set(flags) <= set(FLAGS))
        for service, fields in flags.items():
            keys(fields, FLAGS[service])
            require(all(type(item) is bool or (type(item) is str and item == "unknown") for item in fields.values()))
            result["flags"][service] = {key: fields[key] for key in FLAGS[service]}
        baseline = value["baseline_flags"]
        keys(baseline, ("status", "checked_fields", "unverified_fields"))
        result["baseline_flags"] = {"status": enum(baseline["status"], {"unchanged", "changed", "partial", "not_checked"}),
            "checked_fields": count(baseline["checked_fields"], sum(map(len, FLAGS.values()))),
            "unverified_fields": count(baseline["unverified_fields"], sum(map(len, FLAGS.values())))}
        require(baseline["checked_fields"] + baseline["unverified_fields"] <= sum(map(len, FLAGS.values())))
        if baseline["status"] == "unchanged":
            require(baseline["checked_fields"] + baseline["unverified_fields"] > 0)
        if baseline["status"] == "changed":
            require(baseline["checked_fields"] + baseline["unverified_fields"] > 0)
        if baseline["status"] == "partial":
            require(baseline["unverified_fields"] > 0)
        keys(value["application_http"], APPS)
        for service, fields in value["application_http"].items():
            keys(fields, ("live", "ready"))
            result["application_http"][service] = {key: enum(fields[key], {"passed", "unavailable"}) for key in ("live", "ready")}
        keys(value["internal_http"], ("identity_auth", "unknown_route", "web"))
        result["internal_http"] = {key: enum(item, {"passed", "unavailable"}) for key, item in value["internal_http"].items()}
        keys(value["queues"], QUEUE_FIELDS)
        for service, item in value["queues"].items():
            require(type(item) is dict and "status" in item)
            status = enum(item["status"], {"not_checked", "observed"})
            keys(item, ("status",) if status == "not_checked" else ("status", "counts"))
            result["queues"][service] = {"status": status}
            if status == "observed":
                keys(item["counts"], QUEUE_FIELDS[service])
                result["queues"][service]["counts"] = {key: count(item["counts"][key]) for key in QUEUE_FIELDS[service]}
        keys(value["migrations"], APPS)
        for service, item in value["migrations"].items():
            require(type(item) is dict and "status" in item)
            status = enum(item["status"], {"not_checked", "match", "mismatch"})
            fields = ("expected", "applied", "missing", "changed", "unexpected")
            keys(item, ("status",) if status == "not_checked" else ("status", *fields))
            result["migrations"][service] = {"status": status}
            if status != "not_checked":
                result["migrations"][service].update({key: count(item[key], 1000) for key in fields})
                require(1 <= item["expected"] <= 200 and item["missing"] <= item["expected"]
                        and item["changed"] <= item["expected"] - item["missing"]
                        and item["applied"] == item["expected"] - item["missing"] + item["unexpected"])
                require((status == "match") == (not any(item[key] for key in ("missing", "changed", "unexpected"))))
        timers = value["timers"]
        require(type(timers) is list and len(timers) == len(TIMER_SERVICES))
        seen = set()
        for item in timers:
            keys(item, ("timer", "load", "active", "enabled", "last_run", "qualification"))
            timer = enum(item["timer"], TIMER_SERVICES)
            require(timer not in seen and item["qualification"] == "status_only")
            seen.add(timer)
            result["timers"].append({"timer": timer,
                "load": enum(item["load"], {"loaded", "not-found", "masked", "error", "unknown"}),
                "active": enum(item["active"], {"active", "inactive", "failed", "activating", "deactivating", "unknown"}),
                "enabled": enum(item["enabled"], {"enabled", "enabled-runtime", "disabled", "static", "masked", "indirect", "unknown"}),
                "last_run": enum(item["last_run"], {"succeeded", "failed", "running", "not_run", "unavailable"}), "qualification": "status_only"})
        problems = value["problems"]
        require(type(problems) is list and len(problems) <= len(PROBLEMS)
                and all(type(item) is str and item in PROBLEMS for item in problems) and len(set(problems)) == len(problems))
        result["problems"] = list(problems)
        require(set(problems) - {"inventory_unavailable"} == problem_codes(result))
        require(type(value["software_checks_passed"]) is bool and value["software_checks_passed"] == (not problems))
        if not problems:
            require(names == set(SERVICES) and set(flags) == set(FLAGS)
                    and all(item["revision"] == "match" for item in result["services"] if item["service"] in RELEASE_SERVICES)
                    and all(item == "match" for item in result["database_identity"].values())
                    and baseline["status"] == "unchanged"
                    and all(item == "passed" for row in result["application_http"].values() for item in row.values())
                    and all(item == "passed" for item in result["internal_http"].values())
                    and all(item["status"] == "observed" and not any(item["counts"].values()) for item in result["queues"].values())
                    and all(item["status"] == "match" for item in result["migrations"].values()))
        result["software_checks_passed"] = value["software_checks_passed"]
        return result
    except (KeyError, ValueError, TypeError, AttributeError, RecursionError):
        raise PostcheckError("invalid_report") from None


def remote_report(host, project, expected_commit, expected_database_id, *, expected_migrations=None, baseline_flags=None):
    require(type(host) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,252}", host), "invalid_arguments")
    validate_inputs(project, expected_commit, expected_database_id, expected_migrations, baseline_flags)
    remote = ["python3", "-I", "-B", "-S", "-", "--remote", "--project", project,
              "--expected-commit", expected_commit, "--expected-database-id", expected_database_id]
    if expected_migrations is not None:
        remote += ["--expected-migrations-json", json.dumps(expected_migrations, separators=(",", ":"))]
    if baseline_flags is not None:
        remote += ["--baseline-flags-json", json.dumps(baseline_flags, separators=(",", ":"))]
    raw = command(["ssh", *SSH_OPTIONS, host, shlex.join(remote)], payload=Path(__file__).read_bytes(), timeout=300)
    try:
        return validate_report(json.loads(raw), project, expected_commit)
    except (ValueError, RecursionError):
        raise PostcheckError("invalid_report") from None


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise PostcheckError("invalid_arguments")


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument("--remote", action="store_true", required=True, help=argparse.SUPPRESS)
    parser.add_argument("--project", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--expected-database-id", required=True)
    parser.add_argument("--expected-migrations-json")
    parser.add_argument("--baseline-flags-json")
    try:
        args = parser.parse_args(argv)
        require(sys.version_info >= (3, 9), "invalid_arguments")
        values = []
        for raw in (args.expected_migrations_json, args.baseline_flags_json):
            require(raw is None or len(raw.encode("utf-8")) <= MAX_INPUT, "invalid_arguments")
            values.append(json.loads(raw) if raw is not None else None)
        report = collect(args.project, args.expected_commit, args.expected_database_id,
                         expected_migrations=values[0], baseline_flags=values[1])
        print(json.dumps(report, separators=(",", ":")))
        return 0  # Successful observation can still report unresolved checks.
    except (PostcheckError, ValueError, TypeError, OSError, RecursionError):
        print('{"error":"postcheck_unavailable"}')
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
