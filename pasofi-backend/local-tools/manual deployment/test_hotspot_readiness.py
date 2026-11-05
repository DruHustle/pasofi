"""Offline collector checks: no Docker daemon, SSH connection or credentials."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("hotspot_readiness", Path(__file__).with_name("hotspot-readiness.py"))
READINESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READINESS)
SECRET = "DO_NOT_DISCLOSE_test_password_and_private_payload"
RETAINED = "1234567890123456789"


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pasofi readiness ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.compose = self.root / "compose.yaml"
        self.overlay = self.root / "radius overlay.yaml"
        self.env = self.root / "compose.env"
        self.extra_env = self.root / "extra.env"
        self.record = self.root / "cluster-system-id"
        for path in (self.compose, self.overlay, self.env, self.extra_env):
            path.write_text(SECRET)
        self.record.write_text(RETAINED + "\n")
        self.record.chmod(0o600)
        self.env_patch = patch.object(READINESS, "HISTORICAL_ENV", self.env)
        self.id_patch = patch.object(READINESS, "RETAINED_ID", self.record)
        self.env_patch.start()
        self.id_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.addCleanup(self.id_patch.stop)
        self.rows = []
        for index, name in enumerate(READINESS.SERVICES, 1):
            self.rows.append({"Id": format(index, "064x"), "State": {"Running": True, "Health": {"Status": "healthy"}},
                "Config": {"Labels": {
                    READINESS.LABEL + "project": "pasofi-production", READINESS.LABEL + "service": name,
                    READINESS.LABEL + "project.working_dir": str(self.root),
                    READINESS.LABEL + "project.config_files": str(self.compose) + "," + str(self.overlay),
                    READINESS.LABEL + "project.environment_file": str(self.env) + "," + str(self.extra_env),
                    "org.opencontainers.image.revision": "a" * 40, "private.label": SECRET},
                    "Env": ["DATABASE_URL=" + SECRET, "DATABASE_URL_FILE=/run/secrets/database_url",
                            "PAMOFI_COMMERCE_ENABLED=false", "PAMOFI_CUSTOMER_NETWORK_ENABLED=false",
                            "PAMOFI_RADIUS_QUALIFIED=false", "ROUTER_FLEET_ENABLED=" + SECRET,
                            "PGDATA=/var/lib/postgresql/data/pgdata"]}, "private_inspection_data": SECRET})
        self.calls = []
        self.current_id = RETAINED
        self.nas = {"registered": 2, "enabled": 0, "sites": 2}

    def fake_command(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if argv[:4] == ["docker", "ps", "--all", "--quiet"]:
            expression = argv[-1].removeprefix("label=")
            key, value = expression.split("=", 1)
            return "\n".join(row["Id"] for row in self.rows if row["Config"]["Labels"].get(key) == value)
        if argv[:2] == ["docker", "inspect"]:
            return json.dumps([row for row in self.rows if row["Id"] in argv[2:]])
        if "pg_controldata" in argv:
            return "Database system identifier: " + self.current_id + "\nExtra private output: " + SECRET
        if argv[:2] == ["docker", "exec"] and argv[-1] == READINESS.NAS_PROGRAM:
            return json.dumps(self.nas)
        self.fail("Unexpected command: " + repr(argv))

    def collect(self, project=None):
        with patch.object(READINESS, "command", side_effect=self.fake_command):
            return READINESS.collect(project)

    def test_inventory_is_read_only_and_never_exports_environment_or_raw_command_data(self):
        before = {path: path.read_bytes() for path in self.root.iterdir()}
        report = self.collect()
        self.assertEqual(report["project"], "pasofi-production")
        self.assertEqual(report["database_identity"]["status"], "match")
        self.assertEqual(report["nas_registry"], {"status": "observed", **self.nas})
        self.assertFalse(report["customer_ready"])
        self.assertEqual(report["physical_checks"], "not_performed")
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertEqual(report["flags"]["network"]["ROUTER_FLEET_ENABLED"], "unknown")
        self.assertEqual(before, {path: path.read_bytes() for path in self.root.iterdir()})
        for argv, _ in self.calls:
            self.assertIn(argv[:2], (["docker", "ps"], ["docker", "inspect"], ["docker", "exec"]))
            if argv[:2] == ["docker", "exec"]:
                self.assertTrue("pg_controldata" in argv or argv[-1] == READINESS.NAS_PROGRAM)
        self.assertIn("BEGIN READ ONLY", READINESS.NAS_PROGRAM)
        self.assertIn("ROLLBACK", READINESS.NAS_PROGRAM)
        self.assertIn("statement_timeout:3000", READINESS.NAS_PROGRAM)

    def test_ambiguous_projects_stop_before_database_queries_and_require_an_explicit_choice(self):
        other = copy.deepcopy(self.rows[2])
        other["Id"] = "f" * 64
        other["Config"]["Labels"][READINESS.LABEL + "project"] = "pasofi-staging"
        self.rows.append(other)
        report = self.collect()
        self.assertIn("project_missing_or_ambiguous", report["blockers"])
        self.assertEqual(report["project_candidates"], ["pasofi-production", "pasofi-staging"])
        self.assertFalse(any(argv[:2] == ["docker", "exec"] for argv, _ in self.calls))
        self.assertEqual(self.collect("pasofi-production")["project"], "pasofi-production")

    def test_env_file_order_requires_every_container_record_and_is_never_inferred_from_history(self):
        label = READINESS.LABEL + "project.environment_file"
        report = self.collect()
        self.assertEqual(report["stack"]["environment_files"], [str(self.env), str(self.extra_env)])
        self.rows[0]["Config"]["Labels"].pop(label)
        report = self.collect()
        self.assertEqual(report["stack"]["environment_files"], "unresolved")
        self.assertTrue(report["stack"]["historical_environment_candidate"]["present"])
        self.assertIn("environment_file_order_not_established", report["blockers"])
        self.rows[0]["Config"]["Labels"][label] = str(self.extra_env) + "," + str(self.env)
        self.assertEqual(self.collect()["stack"]["environment_files"], "unresolved")

    def test_compose_overlay_order_uses_the_existing_ordered_superset_contract(self):
        label = READINESS.LABEL + "project.config_files"
        self.rows[0]["Config"]["Labels"][label] = str(self.compose)
        self.assertEqual(self.collect()["stack"]["compose_files"], [str(self.compose), str(self.overlay)])
        self.rows[0]["Config"]["Labels"][label] = str(self.overlay) + "," + str(self.compose)
        report = self.collect()
        self.assertEqual(report["stack"]["compose_files"], "unresolved")
        self.assertIn("compose_stack_not_established", report["blockers"])

    def test_missing_retained_identity_is_not_replaced_with_live_cluster_identity(self):
        self.record.unlink()
        report = self.collect()
        self.assertEqual(report["database_identity"]["status"], "retained_record_missing")
        self.assertNotIn("retained_system_identifier", report["database_identity"])
        self.assertFalse(self.record.exists())
        self.assertFalse(any("pg_controldata" in argv for argv, _ in self.calls))

    def test_mismatched_cluster_identity_stays_blocked_and_does_not_export_or_adopt_current_id(self):
        self.current_id = "9876543210987654321"
        report = self.collect()
        self.assertEqual(report["database_identity"]["status"], "mismatch")
        self.assertEqual(report["database_identity"]["retained_system_identifier"], RETAINED)
        self.assertIn("retained_database_identity_not_verified", report["blockers"])
        self.assertNotIn(self.current_id, json.dumps(report))
        self.assertEqual(self.record.read_text(), RETAINED + "\n")

    def test_untrusted_or_malformed_retained_records_are_not_followed_or_disclosed(self):
        for kind in ("malformed", "oversized", "writable", "symlink"):
            with self.subTest(kind=kind):
                self.record.unlink()
                if kind == "symlink":
                    self.record.symlink_to(self.env)
                else:
                    self.record.write_text(SECRET if kind == "malformed" else "1" * 200 if kind == "oversized" else RETAINED)
                    self.record.chmod(0o666 if kind == "writable" else 0o600)
                self.calls = []
                report = self.collect()
                self.assertEqual(report["database_identity"]["status"], "retained_record_unusable")
                self.assertNotIn(SECRET, json.dumps(report))
                self.assertFalse(any("pg_controldata" in argv for argv, _ in self.calls))

    def test_invalid_nas_aggregate_is_redacted_and_marked_not_checked(self):
        self.nas["password"] = SECRET
        report = self.collect()
        self.assertEqual(report["nas_registry"], {"status": "not_checked"})
        self.assertIn("nas_registry_not_checked", report["blockers"])
        self.assertNotIn(SECRET, json.dumps(report))

    def test_ssh_is_strict_bounded_and_streams_fixed_python_without_staging_or_apply(self):
        report = READINESS.base_report()
        with patch.object(READINESS, "command", return_value=json.dumps(report)) as run:
            self.assertEqual(READINESS.remote_report("existing-oracle", "pasofi-production"), report)
        argv = run.call_args.args[0]
        self.assertEqual(argv[:2], ["ssh", "-T"])
        for setting in ("BatchMode=yes", "StrictHostKeyChecking=yes", "UpdateHostKeys=no", "ClearAllForwardings=yes", "ForwardAgent=no", "PermitLocalCommand=no", "ControlPath=none"):
            self.assertIn(setting, argv)
        self.assertEqual(argv[-2:], ["existing-oracle", "python3 -I -B -S - --remote --project pasofi-production"])
        self.assertEqual(run.call_args.kwargs["payload"], Path(READINESS.__file__).read_bytes())
        self.assertEqual(run.call_args.kwargs["timeout"], 150)
        self.assertNotIn("scp", argv)
        self.assertNotIn("--apply", argv)

    def test_invalid_inputs_and_unknown_flags_never_connect_or_echo_the_supplied_value(self):
        examples = [["--host", "$(touch " + SECRET + ")"], ["--host", "-oProxyCommand=" + SECRET],
                    ["--host", "existing", "--project", "prod;" + SECRET],
                    ["--host", "existing", "--apply", SECRET], ["--remote", "--output", SECRET]]
        for args in examples:
            with self.subTest(args=args), patch.object(READINESS, "command") as run, contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(READINESS.main(args), 1)
                self.assertNotIn(SECRET, errors.getvalue())
                run.assert_not_called()

    def test_command_failures_timeouts_and_oversized_output_do_not_echo_private_output(self):
        cases = [([sys.executable, "-c", "import sys; print('" + SECRET + "', file=sys.stderr); sys.exit(2)"], {}, "command_failed"),
                 ([sys.executable, "-c", "import time; time.sleep(5)"], {"timeout": 0.05}, "command_timed_out"),
                 ([sys.executable, "-c", "import sys; sys.stdout.write('x'*32768)"], {}, "command_output_limit")]
        for argv, kwargs, expected in cases:
            with self.subTest(expected=expected), patch.object(READINESS, "MAX_OUTPUT", 4096), contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaisesRegex(READINESS.DiagnosticError, "^" + expected + "$"):
                    READINESS.command(argv, **kwargs)
                self.assertNotIn(SECRET, output.getvalue() + errors.getvalue())

    def test_private_output_is_exclusive_and_never_replaces_an_existing_file_or_symlink(self):
        report = READINESS.base_report()
        path = self.root / "private report.json"
        saved = READINESS.save_report(report, path)
        self.assertEqual(saved, path)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            READINESS.save_report(report, path)
        link = self.root / "report-link.json"
        link.symlink_to(self.env)
        with self.assertRaises(OSError):
            READINESS.save_report(report, link)
        self.assertEqual(self.env.read_text(), SECRET)
        with patch.object(READINESS.Path, "cwd", return_value=self.root):
            default = READINESS.save_report(report)
            self.assertEqual(stat.S_IMODE(default.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(default.stat().st_mode), 0o600)
            default.parent.chmod(0o755)
            with self.assertRaisesRegex(READINESS.DiagnosticError, "report_directory_not_private"):
                READINESS.save_report(report)

    def test_unavailable_ssh_saves_only_a_sanitized_incomplete_report(self):
        output = self.root / "unavailable.json"
        with patch.object(READINESS, "command", side_effect=READINESS.DiagnosticError(SECRET)), contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(READINESS.main(["--host", "existing", "--output", str(output)]), 1)
        report = json.loads(output.read_text())
        self.assertIn("ssh_or_remote_collection_unavailable", report["blockers"])
        self.assertNotIn(SECRET, json.dumps(report) + stdout.getvalue())
        self.assertFalse(report["customer_ready"])

    def test_unexpected_error_details_never_become_report_text(self):
        with patch.object(READINESS, "command", side_effect=READINESS.DiagnosticError(SECRET)):
            report = READINESS.collect()
        self.assertIn("diagnostic_data_unavailable", report["blockers"])
        self.assertNotIn(SECRET, json.dumps(report))

    def test_non_report_ssh_output_is_discarded_instead_of_saved_as_a_diagnostic(self):
        for raw in (SECRET, json.dumps({**READINESS.base_report(), "unexpected_environment": SECRET})):
            with self.subTest(raw=raw):
                output = self.root / ("invalid-report-" + str(len(raw)) + ".json")
                with patch.object(READINESS, "command", return_value=raw), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(READINESS.main(["--host", "existing", "--output", str(output)]), 1)
                report = json.loads(output.read_text())
                self.assertNotIn(SECRET, json.dumps(report))
                self.assertIn("ssh_or_remote_collection_unavailable", report["blockers"])

    def assert_remote_report_rejected(self, report, name, project=None):
        output = self.root / (name + ".json")
        args = ["--host", "existing", "--output", str(output)]
        if project:
            args += ["--project", project]
        with patch.object(READINESS, "command", return_value=json.dumps(report)), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(READINESS.main(args), 1)
        saved = json.loads(output.read_text())
        self.assertEqual(saved["blockers"], ["ssh_or_remote_collection_unavailable", "physical_acceptance_not_performed"])
        self.assertEqual(saved["flags"], {})
        self.assertEqual(saved["stack"], {})
        self.assertEqual(saved["database_identity"], {})
        self.assertEqual(saved["services"], [])
        self.assertFalse(saved["customer_ready"])
        self.assertNotIn(SECRET, output.read_text() + stdout.getvalue() + stderr.getvalue())

    def test_nested_secret_fields_are_rejected_before_any_remote_data_is_saved(self):
        original = self.collect()
        injections = [
            ("flags", lambda r: r["flags"]["network"].update(DATABASE_URL=SECRET)),
            ("service", lambda r: r["services"][0].update(Env=[SECRET])),
            ("stack", lambda r: r["stack"].update(environment_contents=SECRET)),
            ("historical", lambda r: r["stack"]["historical_environment_candidate"].update(password=SECRET)),
            ("database", lambda r: r["database_identity"].update(connection_string=SECRET)),
            ("nas", lambda r: r["nas_registry"].update(credential=SECRET)),
            ("blocker", lambda r: r["blockers"].append(SECRET)),
            ("input", lambda r: r["next_inputs"].append(SECRET)),
        ]
        for name, inject in injections:
            with self.subTest(name=name):
                report = copy.deepcopy(original)
                inject(report)
                self.assert_remote_report_rejected(report, "secret-" + name)

    def test_null_and_malformed_nested_shapes_save_a_sanitized_incomplete_report_without_crashing(self):
        original = self.collect()
        mutations = [
            ("null-blockers", lambda r: r.update(blockers=None)),
            ("null-flags", lambda r: r.update(flags=None)),
            ("null-services", lambda r: r.update(services=None)),
            ("null-stack", lambda r: r.update(stack=None)),
            ("null-database", lambda r: r.update(database_identity=None)),
            ("null-nas", lambda r: r.update(nas_registry=None)),
            ("null-inputs", lambda r: r.update(next_inputs=None)),
            ("candidate-object", lambda r: r.update(project_candidates=[{"name": SECRET}])),
            ("service-string", lambda r: r.update(services=[SECRET])),
            ("gate-integer", lambda r: r["flags"]["network"].update(ROUTER_FLEET_ENABLED=1)),
            ("version-object", lambda r: r["services"][0].update(source_revision={"secret": SECRET})),
            ("count-boolean", lambda r: r["nas_registry"].update(enabled=True)),
            ("count-negative", lambda r: r["nas_registry"].update(registered=-1)),
            ("count-overflow", lambda r: r["nas_registry"].update(registered=2147483648)),
            ("count-inconsistent", lambda r: r["nas_registry"].update(enabled=3)),
            ("relative-path", lambda r: r["stack"].update(compose_files=["relative/" + SECRET])),
            ("path-traversal", lambda r: r["stack"].update(environment_files=["/a/../" + SECRET])),
            ("path-control", lambda r: r["stack"].update(working_directory="/private/\n" + SECRET)),
            ("timestamp", lambda r: r.update(checked_at_utc="2026-99-99T99:99:99+00:00")),
        ]
        for name, mutate in mutations:
            with self.subTest(name=name):
                report = copy.deepcopy(original)
                mutate(report)
                self.assert_remote_report_rejected(report, name)

    def test_returned_project_must_match_the_explicit_selection_when_not_null(self):
        report = self.collect()
        self.assert_remote_report_rejected(report, "wrong-selected-project", "pasofi-staging")
        with patch.object(READINESS, "command", return_value=json.dumps(report)):
            accepted = READINESS.remote_report("existing", "pasofi-production")
        self.assertEqual(accepted["project"], "pasofi-production")
        unresolved = READINESS.base_report()
        unresolved["project_candidates"] = ["pasofi-production", "pasofi-staging"]
        unresolved["blockers"] = ["project_missing_or_ambiguous", "physical_acceptance_not_performed"]
        with patch.object(READINESS, "command", return_value=json.dumps(unresolved)):
            self.assertIsNone(READINESS.remote_report("existing", "pasofi-production")["project"])

    def test_valid_projection_has_no_shared_nested_data_and_never_reads_remote_paths_locally(self):
        report = self.collect()
        for method in ("is_file", "is_dir", "stat", "lstat", "resolve", "read_bytes", "read_text"):
            with self.subTest(method=method), patch.object(READINESS.Path, method, side_effect=AssertionError("Remote path inspected locally")):
                projected = READINESS.validate_report(report, "pasofi-production")
                self.assertEqual(projected, report)
        report["flags"]["network"]["ROUTER_FLEET_ENABLED"] = True
        report["stack"]["compose_files"].append("/new/remote/path.yaml")
        self.assertEqual(projected["flags"]["network"]["ROUTER_FLEET_ENABLED"], "unknown")
        self.assertNotIn("/new/remote/path.yaml", projected["stack"]["compose_files"])
        bad = READINESS.base_report()
        bad["blockers"] = None
        destination = self.root / "must-not-be-created.json"
        with self.assertRaisesRegex(READINESS.DiagnosticError, "remote_report_invalid"):
            READINESS.save_report(bad, destination)
        self.assertFalse(destination.exists())


class ReadinessMacLauncherTests(unittest.TestCase):
    def test_paths_with_spaces_and_literal_prompt_input_are_passed_without_shell_evaluation(self):
        with tempfile.TemporaryDirectory(prefix="PasoFi Mac Readiness ") as temporary:
            root = Path(temporary)
            launcher = root / "hotspot-readiness.command"
            launcher.write_bytes(Path(__file__).with_name("hotspot-readiness.command").read_bytes())
            (root / "hotspot-readiness.py").write_text("import json, pathlib, sys\npathlib.Path('args.json').write_text(json.dumps(sys.argv[1:]))\n")
            marker = root / "must-not-exist"
            host = "$(touch '" + str(marker) + "')"
            environment = dict(os.environ)
            environment.pop("BASH_ENV", None)
            environment.pop("ENV", None)
            result = subprocess.run(["/bin/bash", str(launcher)], cwd=root, input=host + "\nexisting-project\n", text=True,
                                    capture_output=True, env=environment, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((root / "args.json").read_text()), ["--host", host, "--project", "existing-project"])
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
