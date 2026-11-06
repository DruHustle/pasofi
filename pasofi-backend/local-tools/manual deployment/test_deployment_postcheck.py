"""Offline post-deployment checks; no server, provider or real Docker access."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

SOURCE = Path(__file__).with_name("deployment-postcheck.py")
SPEC = importlib.util.spec_from_file_location("postcheck", SOURCE)
postcheck = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(postcheck)
PROJECT = "existing-pasofi"
COMMIT = "a" * 40
DATABASE = "1234567890123456789"
SECRET = "SHOULD_NEVER_APPEAR_IN_REPORT"


class FakeHost:
    def __init__(self):
        self.calls = []
        self.rows = []
        self.images = []
        self.queue_override = {}
        self.migration_override = {}
        self.http_override = {}
        self.timer_override = {}
        self.live_database = DATABASE
        for index, service in enumerate(postcheck.SERVICES, 1):
            env = ["SECRET_TOKEN=" + SECRET]
            if service in postcheck.FLAGS:
                env += [key + "=false" for key in postcheck.FLAGS[service]]
            if service == "postgres":
                env += ["PGDATA=/var/lib/postgresql/data/pgdata"]
            image_id = "sha256:" + format(index, "064x")
            row = {"Id": format(index, "064x"), "Image": image_id,
                   "Config": {"Labels": {postcheck.LABEL + "project": PROJECT,
                       postcheck.LABEL + "service": service, postcheck.LABEL + "oneoff": "False",
                       "org.opencontainers.image.revision": COMMIT}, "Env": env, "Cmd": [SECRET]},
                   "State": {"Running": True, "Health": {"Status": "healthy"}, "Error": SECRET}}
            self.rows.append(row)
            if service in postcheck.RELEASE_SERVICES:
                self.images.append({"Id": image_id, "Config": {"Labels": {"org.opencontainers.image.revision": COMMIT}}})
        self.by_id = {row["Id"]: row for row in self.rows}

    def row(self, name):
        return next(row for row in self.rows if row["Config"]["Labels"][postcheck.LABEL + "service"] == name)

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        if argv[:2] == ["docker", "ps"]:
            if "label=" + postcheck.LABEL + "project=" + PROJECT not in argv:
                raise AssertionError("Wrong project filter")
            return "\n".join(row["Id"] for row in self.rows)
        if argv[:2] == ["docker", "inspect"]:
            return json.dumps(self.rows)
        if argv[:3] == ["docker", "image", "inspect"]:
            return json.dumps(self.images)
        if argv[:2] == ["docker", "exec"] and "pg_controldata" in argv:
            return "Database system identifier: " + self.live_database + "\n"
        if argv[:2] == ["docker", "exec"] and argv[3:6] == ["node", "--input-type=module", "-e"]:
            row = self.by_id[argv[2]]
            service = row["Config"]["Labels"][postcheck.LABEL + "service"]
            program = argv[-1]
            if "const checks=" in program:
                checks = json.loads(program.split("const checks=", 1)[1].split("; const result={}", 1)[0])
                values = {item[0]: "passed" for item in checks}
                values.update(self.http_override.get(service, {}))
                return json.dumps(values)
            if "SELECT name,checksum FROM schema_migrations" in program:
                expected = json.loads(re.search(r"const expected=(.*?);", program).group(1))
                return json.dumps(self.migration_override.get(service, {
                    "expected": len(expected), "applied": len(expected), "missing": 0, "changed": 0, "unexpected": 0}))
            if "BEGIN READ ONLY" in program:
                return json.dumps(self.queue_override.get(service, {name: 0 for name in postcheck.QUEUE_FIELDS[service]}))
        if argv[:2] == ["systemctl", "show"]:
            unit = argv[-1]
            values = {"LoadState": "loaded", "ActiveState": "active" if unit.endswith(".timer") else "inactive",
                      "UnitFileState": "enabled" if unit.endswith(".timer") else "static", "Result": "success",
                      "ExecMainCode": "1", "ExecMainStatus": "0", "ExecMainExitTimestampMonotonic": "123456789"}
            values.update(self.timer_override.get(unit, {}))
            return "\n".join(key + "=" + value for key, value in values.items())
        raise AssertionError("Unexpected command type")


class PostcheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pasofi-postcheck-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.retained = self.root / "retained-cluster-id"
        self.retained.write_text(DATABASE + "\n")
        self.retained.chmod(0o600)
        self.addCleanup(patch.stopall)
        patch.object(postcheck, "RETAINED_ID", self.retained).start()
        self.host = FakeHost()
        self.command = patch.object(postcheck, "command", self.host).start()
        self.migrations = {name: {"001_initial.sql": "b" * 64} for name in postcheck.APPS}
        self.baseline = {name: {key: False for key in fields} for name, fields in postcheck.FLAGS.items()}

    def collect(self, **kwargs):
        return postcheck.collect(PROJECT, COMMIT, DATABASE, expected_migrations=kwargs.pop("expected_migrations", self.migrations),
                                 baseline_flags=kwargs.pop("baseline_flags", self.baseline), **kwargs)

    def test_complete_observation_checks_software_without_claiming_customers_ready(self):
        result = self.collect()
        self.assertTrue(result["software_checks_passed"])
        self.assertEqual(result["problems"], [])
        self.assertIs(result["read_only"], True)
        self.assertIs(result["customer_ready"], False)
        self.assertEqual(result["physical_checks"], "not_performed")
        self.assertEqual(result["baseline_flags"], {"status": "unchanged", "checked_fields": 17, "unverified_fields": 0})
        self.assertTrue(all(item["qualification"] == "status_only" for item in result["timers"]))
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertNotIn(DATABASE, json.dumps(result))
        # Check the actual command boundary: no compose up, service restart,
        # user/transaction creation, installed helper execution or message send.
        for argv, _ in self.host.calls:
            if argv[0] == "systemctl":
                self.assertEqual(argv[1], "show")
            else:
                self.assertIn(argv[1], ("ps", "inspect", "image", "exec"))
                if argv[1] == "exec" and "node" in argv:
                    program = argv[-1]
                    self.assertTrue("method:'GET'" in program or "BEGIN READ ONLY" in program)
                    self.assertNotIn("client.query('INSERT", program)
                    self.assertNotIn("client.query('UPDATE", program)

    def test_revision_comes_from_immutable_image_not_overridable_container_label(self):
        self.host.images[0]["Config"]["Labels"]["org.opencontainers.image.revision"] = "c" * 40
        result = self.collect()
        self.assertFalse(result["software_checks_passed"])
        self.assertIn("runtime_revision_not_verified", result["problems"])
        self.assertEqual(next(row for row in result["services"] if row["service"] == "identity")["revision"], "mismatch")

    def test_required_health_and_internal_tls_failures_remain_visible(self):
        self.host.row("network")["State"]["Health"]["Status"] = "unhealthy"
        self.host.http_override["prepaid-access"] = {"identity_auth": "unavailable"}
        result = self.collect()
        self.assertIn("required_service_not_healthy", result["problems"])
        self.assertIn("internal_gateway_not_verified", result["problems"])

    def test_aggregate_counts_require_attention_but_do_not_trigger_actions(self):
        values = {name: 0 for name in postcheck.QUEUE_FIELDS["prepaid-access"]}
        values["network_review"] = 2
        self.host.queue_override["prepaid-access"] = values
        result = self.collect()
        self.assertIn("queue_attention_required", result["problems"])
        self.assertEqual(result["queues"]["prepaid-access"]["counts"]["network_review"], 2)
        self.assertTrue(all(argv[0] in ("docker", "systemctl") for argv, _ in self.host.calls))

    def test_unexpected_aggregate_output_is_discarded_without_secret_leak(self):
        self.host.queue_override["notification"] = {"database_url": SECRET}
        result = self.collect()
        self.assertIn("queues_not_verified", result["problems"])
        self.assertEqual(result["queues"]["notification"], {"status": "not_checked"})
        self.assertNotIn(SECRET, json.dumps(result))

    def test_migration_mismatch_missing_source_and_impossible_counts_are_not_passes(self):
        self.host.migration_override["network"] = {"expected": 1, "applied": 1, "missing": 0, "changed": 1, "unexpected": 0}
        result = self.collect()
        self.assertEqual(result["migrations"]["network"]["status"], "mismatch")
        self.assertIn("migrations_not_verified", result["problems"])
        result = self.collect(expected_migrations=None)
        self.assertTrue(all(item["status"] == "not_checked" for item in result["migrations"].values()))
        self.host.migration_override["network"] = {"expected": 1, "applied": 0, "missing": 0, "changed": 0, "unexpected": 0}
        result = self.collect()
        self.assertEqual(result["migrations"]["network"], {"status": "not_checked"})

    def test_database_matches_independent_retained_record_and_current_cluster(self):
        self.host.live_database = "9999999999999999999"
        result = self.collect()
        self.assertEqual(result["database_identity"], {"retained_record": "match", "live_cluster": "mismatch"})
        self.assertIn("database_identity_not_verified", result["problems"])
        self.retained.unlink()
        result = self.collect()
        self.assertEqual(result["database_identity"]["retained_record"], "missing")
        self.assertFalse(self.retained.exists())

    def test_unsafe_retained_record_is_never_adopted(self):
        target = self.root / "target"
        target.write_text(DATABASE)
        self.retained.unlink()
        self.retained.symlink_to(target)
        result = self.collect()
        self.assertEqual(result["database_identity"]["retained_record"], "unusable")
        self.assertIn("database_identity_not_verified", result["problems"])

    def test_unknown_before_and_after_stays_unknown_without_false_provider_qualification(self):
        field = "PAMOFI_ROUTER_FLEET_ENABLED"
        self.host.row("prepaid-access")["Config"]["Env"] = [entry for entry in self.host.row("prepaid-access")["Config"]["Env"] if not entry.startswith(field + "=")]
        self.baseline["prepaid-access"][field] = "unknown"
        result = self.collect()
        self.assertTrue(result["software_checks_passed"])
        self.assertEqual(result["flags"]["prepaid-access"][field], "unknown")
        self.assertEqual(result["baseline_flags"]["unverified_fields"], 1)
        self.assertFalse(result["customer_ready"])
        self.baseline["prepaid-access"][field] = False
        result = self.collect()
        self.assertIn("baseline_flags_changed", result["problems"])

    def test_changed_boolean_gate_is_not_treated_as_postdeploy_success(self):
        values = self.host.row("prepaid-access")["Config"]["Env"]
        values[values.index("PAMOFI_PAYMENTS_ENABLED=false")] = "PAMOFI_PAYMENTS_ENABLED=true"
        result = self.collect()
        self.assertEqual(result["baseline_flags"]["status"], "changed")
        self.assertIn("baseline_flags_changed", result["problems"])

    def test_systemd_success_default_without_prior_exit_is_not_a_successful_run(self):
        self.host.timer_override["pamofi-restore-drill.service"] = {"ExecMainExitTimestampMonotonic": "0", "ExecMainCode": "0"}
        result = self.collect()
        timer = next(item for item in result["timers"] if item["timer"] == "pamofi-restore-drill.timer")
        self.assertEqual(timer["last_run"], "not_run")
        self.assertEqual(timer["qualification"], "status_only")
        self.assertIn("timer_observation_incomplete", result["problems"])

    def test_unrelated_project_and_duplicate_inventory_are_rejected(self):
        self.host.rows[0]["Config"]["Labels"][postcheck.LABEL + "project"] = "foreign"
        result = self.collect()
        self.assertIn("inventory_unavailable", result["problems"])
        self.assertFalse(result["software_checks_passed"])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_input_schema_rejects_hostile_names_checksums_and_flags_before_commands(self):
        invalid = [
            (PROJECT + ";touch marker", COMMIT, DATABASE, None, None),
            (PROJECT, COMMIT, DATABASE, {"network": {"../secret": "b" * 64}}, None),
            (PROJECT, COMMIT, DATABASE, {"network": {"001_initial.sql": SECRET}}, None),
            (PROJECT, COMMIT, DATABASE, None, {"notification": {"SECRET_KEY": SECRET}}),
        ]
        for args in invalid:
            with self.subTest(args=args[:3]):
                with self.assertRaises(postcheck.PostcheckError):
                    postcheck.validate_inputs(*args)
        self.assertEqual(self.host.calls, [])

    def test_nested_report_schema_and_forged_success_are_rejected(self):
        good = self.collect()
        bad_reports = []
        bad = copy.deepcopy(good); bad["secret"] = SECRET; bad_reports.append(bad)
        bad = copy.deepcopy(good); bad["services"][0]["password"] = SECRET; bad_reports.append(bad)
        bad = copy.deepcopy(good); bad["queues"]["network"]["counts"]["credential"] = SECRET; bad_reports.append(bad)
        bad = copy.deepcopy(good); bad["flags"]["network"]["NETWORK_RECONCILER_ENABLED"] = SECRET; bad_reports.append(bad)
        bad = copy.deepcopy(good); bad["migrations"]["network"]["applied"] = True; bad_reports.append(bad)
        bad = copy.deepcopy(good); bad["timers"][0]["last_run"] = SECRET; bad_reports.append(bad)
        bad = copy.deepcopy(good); bad["project"] = "another-project"; bad_reports.append(bad)
        bad = copy.deepcopy(good); bad["customer_ready"] = True; bad_reports.append(bad)
        bad = copy.deepcopy(good); bad["services"][0]["health"] = "unhealthy"; bad_reports.append(bad)
        bad = copy.deepcopy(good); bad["timers"][0]["active"] = "failed"; bad_reports.append(bad)
        for bad in bad_reports:
            with self.assertRaises(postcheck.PostcheckError):
                postcheck.validate_report(bad, PROJECT, COMMIT)

    def test_remote_contract_streams_fixed_source_with_trust_and_no_fallback(self):
        good = self.collect()
        calls = []
        def remote(argv, **kwargs):
            calls.append((argv, kwargs))
            return json.dumps(good)
        with patch.object(postcheck, "command", remote):
            result = postcheck.remote_report("existing-oracle", PROJECT, COMMIT, DATABASE,
                                             expected_migrations=self.migrations, baseline_flags=self.baseline)
        self.assertTrue(result["software_checks_passed"])
        self.assertEqual(len(calls), 1)
        argv, kwargs = calls[0]
        self.assertEqual(argv[0], "ssh")
        self.assertIn("StrictHostKeyChecking=yes", argv)
        self.assertIn("ForwardAgent=no", argv)
        self.assertIn("ControlPath=none", argv)
        remote_argv = shlex.split(argv[-1])
        self.assertEqual(remote_argv[:6], ["python3", "-I", "-B", "-S", "-", "--remote"])
        self.assertEqual(kwargs["payload"], SOURCE.read_bytes())
        self.assertEqual(kwargs["timeout"], 300)
        self.assertEqual(json.loads(remote_argv[remote_argv.index("--expected-migrations-json") + 1]), self.migrations)

    def test_malformed_remote_report_cannot_leak_fields_or_become_success(self):
        with patch.object(postcheck, "command", return_value=json.dumps({"secret": SECRET})):
            with self.assertRaises(postcheck.PostcheckError) as raised:
                postcheck.remote_report("existing-oracle", PROJECT, COMMIT, DATABASE)
        self.assertNotIn(SECRET, str(raised.exception))

    def test_cli_bounds_json_and_never_prints_bad_input(self):
        output = io.StringIO()
        with redirect_stdout(output):
            status = postcheck.main(["--remote", "--project", PROJECT, "--expected-commit", COMMIT,
                "--expected-database-id", DATABASE, "--expected-migrations-json", SECRET * 10000])
        self.assertEqual(status, 1)
        self.assertEqual(output.getvalue(), '{"error":"postcheck_unavailable"}\n')
        self.assertEqual(self.host.calls, [])


class CommandBoundaryTests(unittest.TestCase):
    def test_failed_command_discards_secret_stderr_and_returns_only_fixed_code(self):
        with self.assertRaises(postcheck.PostcheckError) as raised:
            postcheck.command([sys.executable, "-c", "import sys;sys.stderr.write(" + repr(SECRET) + ");sys.exit(3)"])
        self.assertEqual(str(raised.exception), "command_failed")

    def test_output_and_time_limits_are_enforced(self):
        with patch.object(postcheck, "MAX_OUTPUT", 1024):
            with self.assertRaises(postcheck.PostcheckError) as raised:
                postcheck.command([sys.executable, "-c", "print('x'*3000)"])
            self.assertEqual(str(raised.exception), "command_output_limit")
        with self.assertRaises(postcheck.PostcheckError) as raised:
            postcheck.command([sys.executable, "-c", "import time;time.sleep(2)"], timeout=0.05)
        self.assertEqual(str(raised.exception), "command_timed_out")


if __name__ == "__main__":
    unittest.main()
