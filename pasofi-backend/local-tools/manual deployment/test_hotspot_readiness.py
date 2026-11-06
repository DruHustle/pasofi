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


class AutomaticReadinessTests(unittest.TestCase):
    def setUp(self):
        self.profile = {"schema": 1, "ssh_aliases": ["existing-private", "existing-public"]}
        self.report = READINESS.base_report()
        self.report["blockers"] = ["project_missing_or_ambiguous", "physical_acceptance_not_performed"]

    def test_profile_accepts_only_bounded_aliases_and_optional_explicit_project(self):
        self.assertEqual(READINESS.validate_profile(self.profile), self.profile)
        selected = {**self.profile, "project": "pasofi-production"}
        self.assertEqual(READINESS.validate_profile(selected), selected)
        invalid = [None, {}, {**self.profile, "schema": True}, {**self.profile, "ssh_aliases": []},
                   {**self.profile, "ssh_aliases": ["same", "same"]}, {**self.profile, "ssh_aliases": [None]},
                   {**self.profile, "ssh_aliases": ["$(touch " + SECRET + ")"]},
                   {**self.profile, "ssh_aliases": ["-oProxyCommand=" + SECRET]},
                   {**self.profile, "ssh_aliases": ["host" + str(i) for i in range(5)]},
                   {**self.profile, "password": SECRET}, {**self.profile, "project": None},
                   {**self.profile, "project": "prod;" + SECRET}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(READINESS.DiagnosticError, "^connection_profile_invalid$"):
                READINESS.validate_profile(value)

    def test_profile_loading_rejects_symlinks_oversize_and_extra_secret_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "profile.json"
            path.write_text(json.dumps(self.profile))
            self.assertEqual(READINESS.load_profile(path), self.profile)
            link = path.with_name("link.json")
            link.symlink_to(path)
            with self.assertRaisesRegex(READINESS.DiagnosticError, "connection_profile_invalid"):
                READINESS.load_profile(link)
            for text in (" " * 4097, json.dumps({**self.profile, "key": SECRET}), "invalid: " + SECRET):
                path.write_text(text)
                with self.assertRaisesRegex(READINESS.DiagnosticError, "connection_profile_invalid"):
                    READINESS.load_profile(path)

    def test_configuration_resolution_requires_a_real_hostname_substitution_and_keeps_settings_private(self):
        output = "hostname 100.100.20.4\nuser ubuntu\nidentityfile /private/" + SECRET + "\n"
        with patch.object(READINESS, "command", return_value=output) as command:
            self.assertTrue(READINESS.configured_alias("existing-private"))
        argv = command.call_args.args[0]
        self.assertEqual(argv[:2], ["ssh", "-G"])
        self.assertEqual(argv[-1], "existing-private")
        self.assertIn("StrictHostKeyChecking=yes", argv)
        self.assertIn("PermitLocalCommand=no", argv)
        self.assertEqual(command.call_args.kwargs, {"timeout": 15, "ssh": True})
        with patch.object(READINESS, "command", return_value="hostname Existing-Private.\n"):
            self.assertFalse(READINESS.configured_alias("existing-private"))
        for output in ("hostname x\nhostname y\n", "user " + SECRET, "hostname /private/" + SECRET):
            with self.subTest(output=output), patch.object(READINESS, "command", return_value=output):
                with self.assertRaisesRegex(READINESS.DiagnosticError, "ssh_configuration_unavailable"):
                    READINESS.configured_alias("existing-private")

    def test_preferred_alias_is_used_without_testing_public_when_report_has_installation_blockers(self):
        with patch.object(READINESS, "configured_alias", return_value=True) as configured, \
             patch.object(READINESS, "probe_connection") as probe, \
             patch.object(READINESS, "remote_report", return_value=self.report) as collect:
            report, connection = READINESS.automatic_report(self.profile)
        self.assertEqual(report, self.report)
        self.assertEqual(connection, {"schema": 1, "selection": "automatic", "selected_alias": "existing-private",
                                     "attempts": [{"alias": "existing-private", "status": "collected"}]})
        configured.assert_called_once_with("existing-private")
        probe.assert_called_once_with("existing-private")
        collect.assert_called_once_with("existing-private", None)

    def test_network_failure_uses_public_fallback_but_does_not_reorder_profile(self):
        with patch.object(READINESS, "configured_alias", return_value=True), \
             patch.object(READINESS, "probe_connection", side_effect=[READINESS.DiagnosticError("ssh_network_unavailable"), None]) as probe, \
             patch.object(READINESS, "remote_report", return_value=self.report) as collect:
            report, connection = READINESS.automatic_report(self.profile)
        self.assertEqual(report, self.report)
        self.assertEqual([call.args[0] for call in probe.call_args_list], self.profile["ssh_aliases"])
        collect.assert_called_once_with("existing-public", None)
        self.assertEqual(connection["selected_alias"], "existing-public")
        self.assertEqual([item["status"] for item in connection["attempts"]], ["network_unavailable", "collected"])

    def test_unconfigured_alias_is_skipped_without_a_network_probe(self):
        with patch.object(READINESS, "configured_alias", side_effect=[False, True]), \
             patch.object(READINESS, "probe_connection") as probe, \
             patch.object(READINESS, "remote_report", return_value=self.report):
            _, connection = READINESS.automatic_report(self.profile)
        probe.assert_called_once_with("existing-public")
        self.assertEqual(connection["attempts"][0]["status"], "not_configured")
        with patch.object(READINESS, "configured_alias", return_value=False), patch.object(READINESS, "probe_connection") as probe:
            report, connection = READINESS.automatic_report(self.profile)
        probe.assert_not_called()
        self.assertIsNone(connection["selected_alias"])
        self.assertIn("ssh_or_remote_collection_unavailable", report["blockers"])

    def test_trust_authentication_and_unclassified_failures_never_try_another_alias(self):
        cases = {"ssh_host_key_changed": "host_key_changed", "ssh_host_key_untrusted": "host_key_untrusted",
                 "ssh_authentication_failed": "authentication_failed", "ssh_connection_failed": "connection_failed",
                 "remote_report_invalid": "connection_failed", "command_output_limit": "connection_failed",
                 "command_timed_out": "connection_failed"}
        for error, status in cases.items():
            with self.subTest(error=error), patch.object(READINESS, "configured_alias", return_value=True) as configured, \
                 patch.object(READINESS, "probe_connection", side_effect=READINESS.DiagnosticError(error)), \
                 patch.object(READINESS, "remote_report") as collect:
                report, connection = READINESS.automatic_report(self.profile)
            configured.assert_called_once_with("existing-private")
            collect.assert_not_called()
            self.assertIsNone(connection["selected_alias"])
            self.assertEqual(connection["attempts"], [{"alias": "existing-private", "status": status}])
            self.assertFalse(report["customer_ready"])

    def test_connection_failure_after_successful_probe_never_switches_server(self):
        for error, status in (("command_failed", "remote_collection_unavailable"),
                              ("remote_report_invalid", "remote_report_invalid"),
                              ("command_timed_out", "remote_collection_unavailable")):
            with self.subTest(error=error), patch.object(READINESS, "configured_alias", return_value=True) as configured, \
                 patch.object(READINESS, "probe_connection"), \
                 patch.object(READINESS, "remote_report", side_effect=READINESS.DiagnosticError(error)) as collect:
                report, connection = READINESS.automatic_report(self.profile)
            configured.assert_called_once_with("existing-private")
            collect.assert_called_once_with("existing-private", None)
            self.assertEqual(connection["selected_alias"], "existing-private")
            self.assertEqual(connection["attempts"][0]["status"], status)
            self.assertIn("ssh_or_remote_collection_unavailable", report["blockers"])

    def test_known_project_is_forwarded_without_guessing_and_explicit_override_is_respected(self):
        profile = {**self.profile, "project": "known-production"}
        for override, expected in ((None, "known-production"), ("explicit-production", "explicit-production")):
            with self.subTest(override=override), patch.object(READINESS, "configured_alias", return_value=True), \
                 patch.object(READINESS, "probe_connection"), patch.object(READINESS, "remote_report", return_value=self.report) as collect:
                READINESS.automatic_report(profile, override)
            collect.assert_called_once_with("existing-private", expected)

    def test_ssh_probe_is_fixed_noninteractive_strict_and_has_bounded_timeout(self):
        with patch.object(READINESS, "command", return_value=READINESS.SSH_PROBE + "\n") as command:
            READINESS.probe_connection("existing-private")
        argv = command.call_args.args[0]
        for option in ("StrictHostKeyChecking=yes", "BatchMode=yes", "UpdateHostKeys=no", "ForwardAgent=no",
                       "PermitLocalCommand=no", "ClearAllForwardings=yes", "ControlPath=none"):
            self.assertIn(option, argv)
        self.assertEqual(argv[-2], "existing-private")
        self.assertEqual(argv[-1], "printf '%s\\n' PASOFI_READINESS_SSH_OK")
        self.assertEqual(command.call_args.kwargs, {"timeout": 25, "ssh": True})
        for output in (SECRET, READINESS.SSH_PROBE + "\n" + SECRET):
            with patch.object(READINESS, "command", return_value=output), self.assertRaisesRegex(READINESS.DiagnosticError, "remote_report_invalid"):
                READINESS.probe_connection("existing-private")

    def test_fixed_ssh_error_classification_never_discloses_stderr(self):
        cases = {"REMOTE HOST IDENTIFICATION HAS CHANGED!": "ssh_host_key_changed",
                 "Host key verification failed.": "ssh_host_key_untrusted",
                 "Permission denied (publickey).": "ssh_authentication_failed",
                 "ssh: connect to host 100.100.20.4 port 22: Connection timed out": "ssh_network_unavailable",
                 "No route to host": "ssh_network_unavailable", "Unexpected SSH issue": "ssh_connection_failed"}
        for error, code in cases.items():
            with self.subTest(error=error), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
                program = "import sys; sys.stderr.write(" + repr(error + "\n" + SECRET) + "); sys.exit(255)"
                with self.assertRaisesRegex(READINESS.DiagnosticError, "^" + code + "$"):
                    READINESS.command([sys.executable, "-c", program], ssh=True)
                self.assertNotIn(SECRET, stdout.getvalue() + stderr.getvalue())

    def test_local_connection_provenance_is_validated_and_cannot_be_supplied_by_remote(self):
        connection = {"schema": 1, "selection": "automatic", "selected_alias": "existing-private",
                      "attempts": [{"alias": "existing-private", "status": "collected"}]}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "report.json"
            READINESS.save_report(self.report, path, connection=connection)
            saved = json.loads(path.read_text())
            self.assertEqual(saved.pop("connection"), connection)
            self.assertEqual(saved, self.report)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with self.assertRaisesRegex(READINESS.DiagnosticError, "remote_report_invalid"):
            READINESS.validate_report({**self.report, "connection": connection})
        invalid = [None, {**connection, "secret": SECRET}, {**connection, "schema": True},
                   {**connection, "selected_alias": "another-host"}, {**connection, "selected_alias": None},
                   {**connection, "attempts": [{"alias": "existing-private", "status": SECRET}]},
                   {**connection, "attempts": [{"alias": "existing-private", "status": "host_key_changed"},
                                               {"alias": "existing-public", "status": "collected"}]}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(READINESS.DiagnosticError, "connection_provenance_invalid"):
                READINESS.validate_connection(value)


class ReadinessMacLauncherTests(unittest.TestCase):
    def test_paths_with_spaces_and_literal_cli_arguments_are_passed_without_shell_evaluation(self):
        with tempfile.TemporaryDirectory(prefix="PasoFi Mac Readiness ") as temporary:
            root = Path(temporary)
            launcher = root / "hotspot-readiness.command"
            launcher.write_bytes(Path(__file__).with_name("hotspot-readiness.command").read_bytes())
            (root / "mac-python.sh").write_bytes(Path(__file__).with_name("mac-python.sh").read_bytes())
            (root / "hotspot-readiness.py").write_text("import json, pathlib, sys\npathlib.Path('args.json').write_text(json.dumps(sys.argv[1:]))\n")
            marker = root / "must-not-exist"
            host = "$(touch '" + str(marker) + "')"
            environment = dict(os.environ)
            environment.pop("BASH_ENV", None)
            environment.pop("ENV", None)
            result = subprocess.run(["/bin/bash", str(launcher), "--host", host, "--project", "existing-project"], cwd=root, stdin=subprocess.DEVNULL, text=True,
                                    capture_output=True, env=environment, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((root / "args.json").read_text()), ["--host", host, "--project", "existing-project"])
            self.assertFalse(marker.exists())

    def test_zero_argument_launcher_selects_and_collects_without_reading_terminal_input(self):
        for mode, selected, statuses in (("preferred", "existing-private", ["collected"]),
                                          ("fallback", "existing-public", ["network_unavailable", "collected"]),
                                          ("unconfigured", "existing-public", ["not_configured", "collected"]),
                                          ("hostkey", None, ["host_key_changed"]),
                                          ("auth", None, ["authentication_failed"]),
                                          ("malformed", "existing-private", ["remote_report_invalid"])):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="PasoFi Mac Automatic ") as temporary:
                root = Path(temporary)
                for name in ("hotspot-readiness.command", "hotspot-readiness.py", "mac-python.sh"):
                    (root / name).write_bytes(Path(__file__).with_name(name).read_bytes())
                (root / "mac-connection.json").write_text(json.dumps({"schema": 1, "ssh_aliases": ["existing-private", "existing-public"]}))
                bin_dir = root / "recording tools"
                bin_dir.mkdir()
                log = root / "ssh-calls.jsonl"
                payload = root / "remote-report.json"
                report = READINESS.base_report()
                report["blockers"] = ["project_missing_or_ambiguous", "physical_acceptance_not_performed"]
                payload.write_text(json.dumps(report))
                ssh = bin_dir / "ssh"
                ssh.write_text("#!" + sys.executable + "\n" + '''
import json, os, pathlib, sys
args = sys.argv[1:]
stage = 'configuration' if '-G' in args else 'probe' if args[-1].startswith('printf ') else 'collection'
alias = args[-1] if stage == 'configuration' else args[-2]
with pathlib.Path(os.environ['PASOFI_TEST_CALLS']).open('a') as log:
    log.write(json.dumps({'stage': stage, 'alias': alias, 'arguments': args}) + '\\n')
mode = os.environ['PASOFI_TEST_MODE']
if stage == 'configuration':
    print('hostname ' + (alias if mode == 'unconfigured' and alias == 'existing-private' else '192.0.2.19'))
    print('identityfile /private/DO_NOT_DISCLOSE_test_password_and_private_payload')
elif stage == 'probe':
    if alias == 'existing-private' and mode in ('fallback', 'hostkey', 'auth'):
        message = {'fallback': 'Connection timed out', 'hostkey': 'REMOTE HOST IDENTIFICATION HAS CHANGED!', 'auth': 'Permission denied (publickey).'}[mode]
        print(message + '\\nDO_NOT_DISCLOSE_test_password_and_private_payload', file=sys.stderr)
        sys.exit(255)
    print('PASOFI_READINESS_SSH_OK')
else:
    source = sys.stdin.read()
    assert '--remote' in args[-1] and 'def collect(' in source
    if mode == 'malformed':
        print('DO_NOT_DISCLOSE_test_password_and_private_payload')
    else:
        print(pathlib.Path(os.environ['PASOFI_TEST_REPORT']).read_text())
''')
                ssh.chmod(0o755)
                environment = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                                   PASOFI_TEST_MODE=mode, PASOFI_TEST_CALLS=str(log), PASOFI_TEST_REPORT=str(payload))
                environment.pop("BASH_ENV", None)
                environment.pop("ENV", None)
                result = subprocess.run(["/bin/bash", str(root / "hotspot-readiness.command")], cwd="/",
                                        stdin=subprocess.DEVNULL, text=True, capture_output=True, env=environment, timeout=15)
                self.assertEqual(result.returncode, 1 if mode in ("hostkey", "auth", "malformed") else 0, result.stderr)
                self.assertNotIn("Existing SSH alias:", result.stdout)
                self.assertNotIn("Press Return", result.stdout)
                self.assertNotIn(SECRET, result.stdout + result.stderr)
                reports = list((root / "PasoFi_Readiness").glob("*.json"))
                self.assertEqual(len(reports), 1)
                saved = json.loads(reports[0].read_text())
                self.assertNotIn(SECRET, reports[0].read_text())
                self.assertEqual(saved["connection"]["selected_alias"], selected)
                self.assertEqual([item["status"] for item in saved["connection"]["attempts"]], statuses)
                self.assertFalse(saved["customer_ready"])
                self.assertEqual(stat.S_IMODE(reports[0].stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(reports[0].parent.stat().st_mode), 0o700)
                calls = [json.loads(line) for line in log.read_text().splitlines()]
                for call in calls:
                    for option in ("StrictHostKeyChecking=yes", "BatchMode=yes", "UpdateHostKeys=no", "ClearAllForwardings=yes", "PermitLocalCommand=no"):
                        self.assertIn(option, call["arguments"])
                if mode in ("preferred", "hostkey", "auth", "malformed"):
                    self.assertEqual({call["alias"] for call in calls}, {"existing-private"})

    def test_python_discovery_uses_selected_executable_for_the_launcher(self):
        with tempfile.TemporaryDirectory(prefix="PasoFi Python Choice ") as temporary:
            root = Path(temporary)
            for name in ("hotspot-readiness.command", "mac-python.sh"):
                (root / name).write_bytes(Path(__file__).with_name(name).read_bytes())
            (root / "hotspot-readiness.py").write_text("print('recorded readiness entry')\n")
            bin_dir = root / "installed Python"
            bin_dir.mkdir()
            python = bin_dir / "python3"
            log = root / "python-calls.jsonl"
            python.write_text("#!" + sys.executable + "\n" +
                "import json, os, pathlib, sys\n" +
                "with pathlib.Path(os.environ['PASOFI_TEST_PYTHON_CALLS']).open('a') as log: log.write(json.dumps(sys.argv[1:]) + '\\n')\n" +
                "os.execv(" + repr(sys.executable) + ", [" + repr(sys.executable) + ", *sys.argv[1:]])\n")
            python.chmod(0o755)
            environment = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"], PASOFI_TEST_PYTHON_CALLS=str(log))
            environment.pop("BASH_ENV", None)
            result = subprocess.run(["/bin/bash", str(root / "hotspot-readiness.command")], cwd=root,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, env=environment, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][:4], ["-I", "-B", "-S", "-c"])
            self.assertEqual(calls[1], ["-I", "-B", "-S", str(root / "hotspot-readiness.py")])
            self.assertIn("recorded readiness entry", result.stdout)


if __name__ == "__main__":
    unittest.main()
