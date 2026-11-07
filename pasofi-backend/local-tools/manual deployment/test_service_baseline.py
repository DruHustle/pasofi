"""Mixed installed origins must retain the existing release and data boundaries."""
import argparse
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch


class ServiceBaselineTests(unittest.TestCase):
    def setUp(self):
        specification = importlib.util.spec_from_file_location(
            "baseline_release_fixture", Path(__file__).with_name("test_release_deploy.py"))
        fixture_module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(fixture_module)
        self.fixture = fixture_module.ReleaseSafetyTests("runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.engine = fixture_module.DEPLOY
        self.old_image, self.new_image = fixture_module.OLD_IMAGE, fixture_module.NEW_IMAGE
        f = self.fixture
        f.commands = []
        self.models = {}
        self.expected_hashes = {}
        self.role_result = "matched"
        f.model["services"]["postgres"]["environment"]["POSTGRES_USER"] = "pamofi_bootstrap"
        f.containers["postgres"]["Config"]["Env"].append("POSTGRES_USER=pamofi_bootstrap")
        for name in f.manifest["migrations"]:
            migration = f.model["services"][name + "-migrate"]
            migration["command"] = ["migrate"]
            migration["entrypoint"] = ["node", "/opt/pamofi/entrypoint.mjs"]
            for target in ("/opt/pamofi/entrypoint.mjs", "/opt/pamofi/apply-grants.mjs", "/opt/pamofi/role-policies.json"):
                if not any(item["target"] == target for item in migration.get("volumes", [])):
                    migration.setdefault("volumes", []).append({"type": "bind", "source": str(f.production / Path(target).name),
                                                               "target": target, "read_only": True})
            migration["environment"].update(APP_ENV="production", NODE_ENV="production", PAMOFI_SERVICE=name)
            service = f.model["services"][name]
            runtime = f.containers[name]
            service["environment"].update(APP_ENV="production", NODE_ENV="production", PAMOFI_SERVICE=name)
            for role in ("runtime", "migrate"):
                logical = name.replace("-", "_") + "_" + role + "_url"
                secret = f.production / (logical + ".secret")
                suffix = name.replace("-", "_")
                secret.write_text("postgresql://pamofi_" + suffix + "_" + role + ":synthetic-password@postgres:5432/pamofi_" + suffix)
                f.model["secrets"][logical] = {"file": str(secret)}
                target = "/run/secrets/" + logical
                if role == "runtime":
                    service["environment"]["DATABASE_URL_FILE"] = target
                    service["secrets"] = [{"source": logical}]
                    runtime["Mounts"].append({"Type": "bind", "Source": str(secret), "Destination": target, "RW": False})
                else:
                    migration["environment"]["MIGRATION_DATABASE_URL_FILE"] = target
                    migration["secrets"] = [{"source": logical}]
            runtime["Config"]["Env"] = ["PATH=/image/bin"] + [key + "=" + value for key, value in service["environment"].items()]
        for index, (name, container) in enumerate(f.containers.items()):
            directory = f.root / ("origin-" + name)
            directory.mkdir(mode=0o700)
            staged = name in ("prepaid-access", "gateway")
            source = directory / ("staged.json" if staged else "compose.yaml")
            model = copy.deepcopy(f.model)
            if staged:
                model["services"] = {key: value for key, value in model["services"].items()
                                     if not key.endswith("-migrate")}
                source.write_text(json.dumps(model))
            else:
                source.write_text("# synthetic recorded YAML origin\nservices: {}\n")
            labels = container["Config"]["Labels"]
            labels[self.engine.LABEL + "project.working_dir"] = str(directory)
            labels[self.engine.LABEL + "project.config_files"] = str(source)
            if staged:
                labels.pop(self.engine.LABEL + "project.environment_file")
            else:
                environment = directory / "existing.env"
                environment.write_text("EXAMPLE=not-a-secret\n")
                labels[self.engine.LABEL + "project.environment_file"] = str(environment)
            digest = format(index + 1, "064x")
            labels[self.engine.LABEL + "config-hash"] = digest
            self.expected_hashes[str(source)] = {name: digest}
            self.models[str(source)] = model
        self.directory = f.root / "private-baseline"
        self.directory.mkdir(mode=0o700)
        self.path = self.directory / "baseline.json"
        self.args = copy.copy(f.args)
        self.args.expected_database_id = None
        self.args.env_file = []
        self.args.capture_baseline = str(self.path)
        self.args.baseline = None
        self.args.migration_origin = ["prepaid-access=network"]
        self.output = io.StringIO()
        self.backup = None
        self.build = None

    def compose_result(self, argv):
        def decode(value):
            if isinstance(value, str):
                return value.replace("$$", "$")
            if isinstance(value, list):
                return [decode(item) for item in value]
            if isinstance(value, dict):
                return {key: decode(item) for key, item in value.items()}
            return value
        files = [argv[i + 1] for i, value in enumerate(argv) if value == "-f"]
        first = files[0]
        if first in self.models:
            model = copy.deepcopy(self.models[first])
        else:
            # Simulate Compose JSON interpolation for the retained literal model.
            model = decode(json.loads(Path(first).read_text()))
        for filename in files[1:]:
            overlay = decode(json.loads(Path(filename).read_text()))
            for name, change in overlay["services"].items():
                service = model["services"][name]
                if "image" in change:
                    service["image"] = change["image"]
                if "volumes" in change:
                    replacements = {item["target"]: item for item in change["volumes"]}
                    service["volumes"] = [replacements.get(item["target"], item)
                                          for item in service.get("volumes", [])]
        # Docker Compose 2.40.3 escapes all dollars after JSON serialization.
        return json.dumps(model).replace("$", "$$")

    def run_command(self, argv, **kwargs):
        f = self.fixture
        if "psql" in argv:
            f.commands.append(argv)
            return self.role_result + "\n"
        if argv[:3] == ["docker", "image", "inspect"] and "{{.Id}}" in argv:
            f.commands.append(argv)
            return self.old_image + "\n"
        if "--hash" in argv:
            f.commands.append(argv)
            origin = argv[argv.index("-f") + 1]
            name = argv[-1]
            return name + " " + self.expected_hashes[origin][name] + "\n"
        if argv[-3:] == ["config", "--format", "json"]:
            f.commands.append(argv)
            return self.compose_result(argv)
        return f.fake_run(argv, **kwargs)

    @contextlib.contextmanager
    def operations(self, *, backup_effect=None, build_effect=None):
        f = self.fixture
        with patch.object(self.engine, "run", side_effect=self.run_command), \
                patch.object(self.engine, "inspect_project", side_effect=lambda project=None: ("existing", copy.deepcopy(f.containers))), \
                patch.object(self.engine, "RETAINED_ID", f.retained_id), \
                patch.object(self.engine, "prepare_automatic_backup", return_value={"status": "passed"},
                             side_effect=backup_effect) as backup, \
                patch.object(self.engine, "build_release", return_value={name: self.new_image for name in f.manifest["services"]},
                             side_effect=build_effect) as build, contextlib.redirect_stdout(self.output):
            self.backup, self.build = backup, build
            yield

    def capture(self):
        with self.operations():
            self.engine.deploy(self.args)
        self.args.capture_baseline = None
        self.args.baseline = str(self.path)
        self.args.migration_origin = []

    def mutating_commands(self):
        return [command for command in self.fixture.commands if "up" in command or "run" in command]

    def origin(self, name):
        path = self.fixture.containers[name]["Config"]["Labels"][self.engine.LABEL + "project.config_files"]
        return path, self.models[path]

    def test_capture_and_preflight_reconstruct_each_actual_origin_without_runtime_writes(self):
        self.capture()
        with self.operations():
            self.engine.deploy(self.args)
        self.assertFalse(self.mutating_commands())
        self.backup.assert_not_called()
        self.build.assert_not_called()
        record = json.loads(self.path.read_text())
        model = json.loads(Path(str(self.path) + ".compose.json").read_text())
        self.assertEqual(set(record["origins"]), set(self.fixture.containers))
        self.assertEqual(record["migration_origins"]["prepaid-access"], "network")
        self.assertEqual(record["origins"]["prepaid-access"]["environment_mode"], "self-contained-json")
        self.assertEqual(model["services"]["radius"], self.fixture.model["services"]["radius"])
        self.assertTrue(model["volumes"]["database"]["external"])
        self.assertNotIn("EXISTING_GATE", self.path.read_text())
        self.assertNotIn("EXISTING_GATE", self.output.getvalue())
        for path in self.directory.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(Path(self.args.release_root).exists())

    def test_missing_env_labels_on_yaml_and_unrecorded_json_env_files_are_refused(self):
        labels = self.fixture.containers["network"]["Config"]["Labels"]
        environment = labels.pop(self.engine.LABEL + "project.environment_file")
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "self-contained JSON"):
            self.engine.deploy(self.args)
        labels[self.engine.LABEL + "project.environment_file"] = environment
        path, model = self.origin("prepaid-access")
        model["services"]["prepaid-access"]["env_file"] = [{"path": "/unrecorded.env"}]
        Path(path).write_text(json.dumps(model))
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "unrecorded"):
            self.engine.deploy(self.args)
        self.assertFalse(self.path.exists())

    def test_mismatched_compose_hash_and_retagged_image_cannot_create_a_baseline(self):
        path, _ = self.origin("network")
        self.expected_hashes[path]["network"] = "f" * 64
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "rendered service hash"):
            self.engine.deploy(self.args)
        self.assertFalse(self.path.exists())
        self.expected_hashes[path]["network"] = self.fixture.containers["network"]["Config"]["Labels"][self.engine.LABEL + "config-hash"]
        self.fixture.containers["network"]["Image"] = self.new_image
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "image reference"):
            self.engine.deploy(self.args)
        self.assertFalse(self.mutating_commands())

    def test_each_service_keeps_environment_mount_network_and_port_drift_guards(self):
        cases = [
            ("network", lambda c: c["Config"]["Env"].append("UNRECORDED_GATE=true"), "environment"),
            ("prepaid-access", lambda c: c["Mounts"][0].update(Source="/different/source"), "bind mount"),
            ("radius", lambda c: c["NetworkSettings"]["Networks"].update(unrecorded={}), "networks"),
            ("gateway", lambda c: c["HostConfig"]["PortBindings"].clear(), "published ports"),
        ]
        for name, mutate, message in cases:
            with self.subTest(service=name):
                previous = copy.deepcopy(self.fixture.containers[name])
                mutate(self.fixture.containers[name])
                with self.operations(), self.assertRaisesRegex(self.engine.Refusal, message):
                    self.engine.deploy(self.args)
                self.fixture.containers[name] = previous
        self.assertFalse(self.path.exists())

    def test_conflicting_shared_resources_and_wrong_owned_migrations_are_refused(self):
        _, model = self.origin("network")
        model["networks"]["services"]["internal"] = True
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "shared resource"):
            self.engine.deploy(self.args)
        model["networks"]["services"].pop("internal")
        model["services"]["prepaid-access-migrate"]["environment"]["PAMOFI_SERVICE"] = "identity"
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "service-owned"):
            self.engine.deploy(self.args)
        self.assertFalse(self.path.exists())

    def test_borrowed_migration_requires_pinned_entrypoint_and_all_managed_binds(self):
        _, model = self.origin("network")
        original = copy.deepcopy(model["services"]["prepaid-access-migrate"])
        cases = [(lambda job: job.update(entrypoint=["/bin/true"]), "pinned production entrypoint")]
        for target in ("/opt/pamofi/entrypoint.mjs", "/opt/pamofi/apply-grants.mjs", "/opt/pamofi/role-policies.json"):
            cases.append((lambda job, target=target: job.update(volumes=[item for item in job["volumes"]
                                                                       if item["target"] != target]),
                          "required read-only pinned configuration bind"))
        cases.append((lambda job: job["volumes"][0].update(read_only=False), "required read-only pinned configuration bind"))
        for mutate, message in cases:
            with self.subTest(message=message):
                job = copy.deepcopy(original)
                mutate(job)
                model["services"]["prepaid-access-migrate"] = job
                with self.operations(), self.assertRaisesRegex(self.engine.Refusal, message):
                    self.engine.deploy(self.args)
                self.assertFalse(self.path.exists())
        model["services"]["prepaid-access-migrate"] = original
        self.assertFalse(self.mutating_commands())

    def test_borrowed_migration_cannot_redirect_retained_database_hostname(self):
        _, model = self.origin("network")
        original = copy.deepcopy(model["services"]["prepaid-access-migrate"])
        for key, value in (("extra_hosts", {"postgres": "203.0.113.10"}), ("network_mode", "host"),
                           ("dns", ["203.0.113.10"]), ("links", ["another-service:postgres"])):
            with self.subTest(override=key):
                job = copy.deepcopy(original)
                job[key] = value
                model["services"]["prepaid-access-migrate"] = job
                with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "hostname resolution"):
                    self.engine.deploy(self.args)
                self.assertFalse(self.path.exists())
        for category, target in (("volumes", "/etc/hosts"), ("volumes", "/etc"),
                                 ("secrets", "/etc/resolv.conf"), ("configs", "/etc/nsswitch.conf")):
            with self.subTest(mount=category, target=target):
                job = copy.deepcopy(original)
                job.setdefault(category, []).append({"type": "bind", "source": "/reviewed/other-hosts", "target": target})
                model["services"]["prepaid-access-migrate"] = job
                with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "hostname resolution"):
                    self.engine.deploy(self.args)
                self.assertFalse(self.path.exists())
        model["services"]["prepaid-access-migrate"] = original
        self.assertFalse(self.mutating_commands())

    def test_staged_origin_migration_omission_needs_an_explicit_verified_origin(self):
        self.args.migration_origin = []
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "migration is absent"):
            self.engine.deploy(self.args)
        self.args.migration_origin = ["prepaid-access=unobserved"]
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "observed-service"):
            self.engine.deploy(self.args)
        self.assertFalse(self.mutating_commands())

    def test_borrowed_migration_cannot_point_at_another_database_role_or_postgres(self):
        path = self.fixture.production / "prepaid_access_migrate_url.secret"
        original = path.read_text()
        for value in (original.replace("@postgres:", "@another-server:"),
                      original.replace("pamofi_prepaid_access", "pamofi_identity"),
                      original.replace("_migrate:", "_runtime:")):
            with self.subTest(value=value):
                path.write_text(value)
                with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "database authority"):
                    self.engine.deploy(self.args)
                self.assertFalse(self.path.exists())
        path.write_text(original)
        self.role_result = "mismatch"
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "database authority"):
            self.engine.deploy(self.args)
        self.assertFalse(self.mutating_commands())

    def test_borrowed_migration_preserves_runtime_prefix_production_context_and_secret_bytes(self):
        _, model = self.origin("network")
        migration = model["services"]["prepaid-access-migrate"]
        for key, value in (("PAMOFI_ROLE_PREFIX", "oldprefix"), ("APP_ENV", "demo")):
            with self.subTest(key=key):
                previous = copy.deepcopy(migration["environment"])
                migration["environment"][key] = value
                with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "database authority"):
                    self.engine.deploy(self.args)
                migration["environment"] = previous
        self.capture()
        secret = self.fixture.production / "prepaid_access_migrate_url.secret"
        secret.write_text(secret.read_text().replace("synthetic-password", "different-password"))
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "no longer matches"):
            self.engine.deploy(self.args)
        self.backup.assert_not_called()
        self.assertNotIn("synthetic-password", self.path.read_text())

    def test_changed_source_runtime_and_empty_interpolation_file_stop_before_apply(self):
        self.capture()
        self.args.apply = True
        for kind in ("source", "runtime", "empty_env"):
            with self.subTest(kind=kind):
                path = Path(self.origin("network")[0]) if kind == "source" else Path(str(self.path) + ".empty.env")
                original = path.read_bytes()
                previous = copy.deepcopy(self.fixture.containers["network"])
                if kind == "runtime":
                    self.fixture.containers["network"]["HostConfig"]["Memory"] = 123456
                else:
                    path.write_bytes(original + b"UNREVIEWED=true\n")
                with self.operations(), self.assertRaises(self.engine.Refusal):
                    self.engine.deploy(self.args)
                self.backup.assert_not_called()
                self.build.assert_not_called()
                path.write_bytes(original)
                self.fixture.containers["network"] = previous
        self.assertFalse(self.mutating_commands())

    def test_model_and_release_identity_cannot_be_replaced(self):
        self.capture()
        model_path = Path(str(self.path) + ".compose.json")
        original = model_path.read_bytes()
        model_path.write_bytes(original + b" ")
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "combined baseline model changed"):
            self.engine.deploy(self.args)
        model_path.write_bytes(original)
        record = json.loads(self.path.read_text())
        record["release_commit"] = "b" * 40
        self.path.write_text(json.dumps(record))
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "different release"):
            self.engine.deploy(self.args)

    def test_apply_runs_backup_first_and_preserves_protected_services_and_rollout_order(self):
        self.capture()
        before = self.engine.protected_snapshot(self.fixture.containers)
        self.args.apply = True
        def backup_first(*args):
            self.build.assert_not_called()
            self.assertFalse(self.mutating_commands())
            self.assertEqual(args[1], "1234567890123456789")
            return {"status": "passed"}
        with self.operations(backup_effect=backup_first):
            self.engine.deploy(self.args)
        self.backup.assert_called_once()
        self.assertEqual(self.engine.protected_snapshot(self.fixture.containers), before)
        updates = [command for command in self.fixture.commands if "up" in command]
        targets = [command[command.index("--wait-timeout") + 2:] for command in updates]
        self.assertEqual(targets[:2], [["network"], ["prepaid-access"]])
        self.assertEqual(set(targets[-1]), {"notification", "web", "internal-gateway", "gateway"})
        self.assertFalse(set(self.engine.PROTECTED).intersection(name for phase in targets for name in phase))
        record_path = next(Path(self.args.release_root).glob("*/record.json"))
        record = json.loads(record_path.read_text())
        self.assertIn("service_baseline", record)
        self.assertEqual(record["protected"], before)
        self.assertTrue(record_path.with_name("completed.json").is_file())

    def test_failed_backup_and_build_time_origin_drift_cannot_start_migrations(self):
        self.capture()
        self.args.apply = True
        with self.operations(backup_effect=self.engine.Refusal("backup not qualified")), \
                self.assertRaisesRegex(self.engine.Refusal, "backup not qualified"):
            self.engine.deploy(self.args)
        self.build.assert_not_called()
        self.assertFalse(self.mutating_commands())
        def drift(*_args):
            path = Path(self.origin("notification")[0])
            path.write_text(path.read_text() + "# drift\n")
            return {name: self.new_image for name in self.fixture.manifest["services"]}
        with self.operations(build_effect=drift), self.assertRaisesRegex(self.engine.Refusal, "files changed during build"):
            self.engine.deploy(self.args)
        self.assertFalse(self.mutating_commands())

    def test_every_historical_working_directory_is_locked_before_backup(self):
        self.capture()
        self.args.apply = True
        directory = Path(self.fixture.containers["radius"]["Config"]["Labels"][self.engine.LABEL + "project.working_dir"])
        with self.engine.apply_lock(directory, "existing"), self.operations(), \
                self.assertRaisesRegex(self.engine.Refusal, "Another apply"):
            self.engine.deploy(self.args)
        self.backup.assert_not_called()
        self.assertFalse(self.mutating_commands())

    def test_literal_dollars_and_capture_output_do_not_change_runtime_values(self):
        path, model = self.origin("network")
        literal = "literal-$HOME-${TOKEN}-$$already"
        model["services"]["network"]["environment"]["LITERAL_FIXTURE"] = literal
        self.fixture.containers["network"]["Config"]["Env"].append("LITERAL_FIXTURE=" + literal)
        original_bind = self.fixture.production / "entry-$FIXTURE.mjs"
        original_bind.write_text("// retained synthetic entrypoint\n")
        target = "/opt/pamofi/entrypoint.mjs"
        for volume in model["services"]["network"]["volumes"]:
            if volume["target"] == target:
                volume["source"] = str(original_bind)
        for mount in self.fixture.containers["network"]["Mounts"]:
            if mount["Destination"] == target:
                mount["Source"] = str(original_bind)
        self.capture()
        stored = json.loads(Path(str(self.path) + ".compose.json").read_text())
        self.assertEqual(stored["services"]["network"]["environment"]["LITERAL_FIXTURE"], literal.replace("$", "$$"))
        self.assertNotIn(literal, self.output.getvalue())
        with self.operations():
            self.engine.deploy(self.args)
        self.args.apply = True
        self.args.release_root = str(self.fixture.root / "release-$FIXTURE")
        with self.operations():
            self.engine.deploy(self.args)
        record_path = next(Path(self.args.release_root).glob("*/record.json"))
        rollback = json.loads(record_path.with_name("rollback.compose.json").read_text())
        original = next(item for item in rollback["services"]["network"]["volumes"] if item["target"] == target)
        self.assertEqual(original["source"], str(original_bind).replace("$", "$$"))
        overlay = json.loads(record_path.with_name("upgrade.compose.json").read_text())
        replacement = next(item for item in overlay["services"]["network"]["volumes"] if item["target"] == target)
        self.assertIn("release-$$FIXTURE", replacement["source"])

    def test_serialized_nginx_filter_is_decoded_but_runtime_environment_equality_stays_strict(self):
        path, model = self.origin("gateway")
        key, value = "NGINX_ENVSUBST_FILTER", "^PAMOFI_PUBLIC_HOST$"
        model["services"]["gateway"]["environment"][key] = value
        Path(path).write_text(json.dumps(self.engine.literal_compose(model)))
        environment = self.fixture.containers["gateway"]["Config"]["Env"]
        environment.append(key + "=" + value)
        self.capture()
        stored = json.loads(Path(str(self.path) + ".compose.json").read_text())
        self.assertEqual(stored["services"]["gateway"]["environment"][key], "^PAMOFI_PUBLIC_HOST$$")
        with self.operations():
            self.engine.deploy(self.args)
        environment[-1] = key + "=" + value + "$"
        with self.operations(), self.assertRaisesRegex(self.engine.Refusal, "environment differs"):
            self.engine.deploy(self.args)
        self.assertFalse(self.mutating_commands())

    def test_compose_json_decoder_inverts_serialization_once_and_rejects_unpaired_dollars(self):
        model = {"services": {"fixture": {"environment": {
            "$LITERAL_KEY": "$HOME", "BRACED": "${TOKEN}", "TRAILING": "regex$", "PAIRS": "literal-$$-$$$",
        }}}}
        serialized = json.dumps(model).replace("$", "$$")
        with patch.object(self.engine, "run", return_value=serialized):
            self.assertEqual(self.engine.resolved_compose(["docker", "compose"]), model)
        for value in ("$", "$$$", "escaped-$$-then-$TOKEN"):
            with self.subTest(value=value), patch.object(self.engine, "run", return_value=json.dumps({"value": value})), \
                    self.assertRaisesRegex(self.engine.Refusal, "unexpected dollar escaping"):
                self.engine.resolved_compose(["docker", "compose"])
        encoded = self.engine.literal_compose(model)
        self.assertIn("$LITERAL_KEY", encoded["services"]["fixture"]["environment"])
        self.assertEqual(encoded["services"]["fixture"]["environment"]["$LITERAL_KEY"], "$$HOME")

    def test_capture_cannot_apply_or_mix_other_discovery_modes(self):
        for change in ({"apply": True}, {"discover_existing": True}, {"host": "existing-alias"},
                       {"env_file": [str(self.fixture.env_file)]}, {"expected_database_id": "1234567890123456789"}):
            with self.subTest(change=change):
                args = copy.copy(self.args)
                for key, value in change.items():
                    setattr(args, key, value)
                with self.operations(), self.assertRaises(self.engine.Refusal):
                    self.engine.deploy(args)
        self.assertFalse(self.mutating_commands())


if __name__ == "__main__":
    unittest.main()
