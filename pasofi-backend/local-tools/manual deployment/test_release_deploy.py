"""Offline safety tests: no Docker daemon, SSH connection or secrets are needed."""
import argparse
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("release_deploy", Path(__file__).with_name("release-deploy.py"))
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)
COMMIT = "a" * 40
OLD_IMAGE = "sha256:" + "1" * 64
NEW_IMAGE = "sha256:" + "2" * 64


class ReleaseSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pasofi release test ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.compose_file = self.root / "compose.yaml"
        self.compose_file.write_text("services: {}\n")
        self.env_file = self.root / "protected.env"
        self.env_file.write_text("EXAMPLE=not-a-secret\n")
        self.production = self.root / "existing-production"
        self.production.mkdir()
        self.source_files = ["compose.yaml", "entrypoint.mjs", "apply-grants.mjs", "role-policies.json",
                             "gateway/internal.conf", "gateway/internal-common.conf", "gateway/public.conf.template"]
        for relative in self.source_files:
            path = self.production / relative
            path.parent.mkdir(exist_ok=True)
            path.write_text("// fixture\n")
        self.model = {"name": "existing", "services": {}, "volumes": {"database": {"name": "existing-data", "external": True}},
                      "networks": {"services": {"name": "existing-services"}}, "secrets": {}}
        names = ["prepaid-access", "notification", "web", "gateway", "internal-gateway", "postgres", "radius", "radius-api",
                 "prepaid-access-migrate", "notification-migrate"]
        self.containers = {}
        for name in names:
            service = {"image": "original/" + name + ":qualified", "environment": {"EXISTING_GATE": "false"},
                       "networks": {"services": None}}
            if name in ("prepaid-access", "notification", "gateway"):
                service["tmpfs"] = ["/tmp"]
            if name == "gateway":
                service["tmpfs"].append("/run/secrets:mode=0700")
            if name in ("prepaid-access", "notification") or name.endswith("-migrate"):
                service["volumes"] = [{"type": "bind", "source": str(self.production / "entrypoint.mjs"),
                                       "target": "/opt/pamofi/entrypoint.mjs", "read_only": True}]
            if name.endswith("-migrate"):
                service["volumes"] += [{"type": "bind", "source": str(self.production / filename),
                                         "target": "/opt/pamofi/" + filename, "read_only": True}
                                        for filename in ("apply-grants.mjs", "role-policies.json")]
            if name == "postgres":
                service["environment"]["PGDATA"] = "/var/lib/postgresql/data/pgdata"
                service["volumes"] = [{"type": "volume", "source": "database", "target": "/var/lib/postgresql/data"}]
            if name == "gateway":
                service["volumes"] = [{"type": "bind", "source": str(self.production / "gateway/public.conf.template"),
                                       "target": "/etc/nginx/templates/default.conf.template", "read_only": True}]
                service["ports"] = [{"target": 443, "published": "8443", "host_ip": "127.0.0.1", "protocol": "tcp"}]
            if name == "internal-gateway":
                service["networks"]["services"] = {"aliases": ["identity.internal", "prepaid.internal", "network.internal",
                                                                "notification.internal", "assistant.internal"]}
                service["volumes"] = [{"type": "bind", "source": str(self.production / "gateway/internal.conf"),
                                       "target": "/etc/nginx/conf.d/default.conf", "read_only": True}]
            self.model["services"][name] = service
            if name.endswith("-migrate"):
                continue
            mounts = [{"Type": volume["type"], "Source": volume["source"], "Destination": volume["target"],
                       "Name": "existing-data" if volume["type"] == "volume" else "", "RW": not volume.get("read_only", False)}
                      for volume in service.get("volumes", [])]
            labels = {DEPLOY.LABEL + "project": "existing", DEPLOY.LABEL + "service": name,
                      DEPLOY.LABEL + "project.working_dir": str(self.root),
                      DEPLOY.LABEL + "project.config_files": str(self.compose_file)}
            self.containers[name] = {"Id": name + "-old", "Image": OLD_IMAGE, "State": {"Running": True},
                                     "Config": {"Labels": labels, "Env": ["PATH=/image/bin"] + [k + "=" + v for k, v in service["environment"].items()]},
                                     "Mounts": mounts, "NetworkSettings": {"Networks": {"existing-services": {}}},
                                     "HostConfig": {"PortBindings": {}, "Tmpfs": {
                                         entry.partition(":")[0]: entry.partition(":")[2] for entry in service.get("tmpfs", [])}}}
            self.containers[name]["Name"] = "/existing-" + name + "-1"
            self.containers[name]["NetworkSettings"]["Networks"]["existing-services"]["Aliases"] = [
                "existing-" + name + "-1", name, *(service["networks"]["services"] or {}).get("aliases", [])]
        self.containers["gateway"]["HostConfig"]["PortBindings"] = {"443/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8443"}]}
        self.archive = self.root / "source.tar.gz"
        self.write_archive()
        self.manifest = {"schema": 1, "commit": COMMIT,
                         "archive_sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                         "services": ["prepaid-access", "notification", "web"],
                         "migrations": ["prepaid-access", "notification"]}
        self.manifest_file = self.root / "release.json"
        self.manifest_file.write_text(json.dumps(self.manifest))
        self.args = argparse.Namespace(manifest=str(self.manifest_file), archive=str(self.archive),
                                       expected_database_id="1234567890123456789", env_file=[str(self.env_file)],
                                       host=None, project=None, release_root=str(self.root / "records"), apply=False)

    def write_archive(self, commit=COMMIT, extra=None):
        with tarfile.open(self.archive, "w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": commit}) as bundle:
            for relative in self.source_files:
                data = b"// pinned fixture\n"
                member = tarfile.TarInfo("pasofi/pasofi-backend/infra/production/" + relative)
                member.size = len(data)
                bundle.addfile(member, io.BytesIO(data))
            if extra:
                bundle.addfile(extra)

    def compose_result(self, argv):
        model = copy.deepcopy(self.model)
        # Simulate Compose's volume-by-target merge, while keeping all original services/settings.
        for index, argument in enumerate(argv):
            if argument == "-f" and argv[index + 1].endswith(".json"):
                overlay = json.loads(Path(argv[index + 1]).read_text())
                for name, change in overlay["services"].items():
                    service = model["services"][name]
                    if "image" in change:
                        service["image"] = change["image"]
                    if "volumes" in change:
                        replacements = {v["target"]: v for v in change["volumes"]}
                        service["volumes"] = [replacements.get(v["target"], v) for v in service.get("volumes", [])]
        return json.dumps(model)

    def fake_run(self, argv, **kwargs):
        self.commands.append(argv)
        if argv[:3] == ["docker", "ps", "-aq"]:
            return " ".join(c["Id"] for c in self.containers.values())
        if argv[:2] == ["docker", "inspect"]:
            return json.dumps(self.containers)
        if argv[:3] == ["docker", "image", "inspect"]:
            return json.dumps(["PATH=/image/bin"])
        if "pg_controldata" in argv:
            return "Database system identifier: 1234567890123456789\n"
        if argv[-3:] == ["config", "--format", "json"]:
            return self.compose_result(argv)
        if "up" in argv:
            for name in self.manifest["services"]:
                self.containers[name]["Image"] = NEW_IMAGE
            return ""
        if "run" in argv:
            return ""
        self.fail("Unexpected command in fixture: " + repr(argv))

    def run_plan(self, apply=False):
        self.args.apply = apply
        self.commands = []
        self.plan_output = io.StringIO()
        with patch.object(DEPLOY, "run", side_effect=self.fake_run), \
                patch.object(DEPLOY, "inspect_project", side_effect=lambda project=None: ("existing", copy.deepcopy(self.containers))), \
                patch.object(DEPLOY, "build_release", return_value={name: NEW_IMAGE for name in self.manifest["services"]}), \
                contextlib.redirect_stdout(self.plan_output):
            DEPLOY.deploy(self.args)

    def test_manifest_rejects_hash_mismatch_and_unowned_migration(self):
        self.assertEqual(DEPLOY.load_manifest(self.manifest_file, self.archive)["commit"], COMMIT)
        self.manifest["migrations"].append("identity")
        self.manifest_file.write_text(json.dumps(self.manifest))
        with self.assertRaises(DEPLOY.Refusal):
            DEPLOY.load_manifest(self.manifest_file, self.archive)
        self.manifest["migrations"].remove("identity")
        self.manifest["archive_sha256"] = "0" * 64
        self.manifest_file.write_text(json.dumps(self.manifest))
        with self.assertRaises(DEPLOY.Refusal):
            DEPLOY.load_manifest(self.manifest_file, self.archive)

    def test_archive_pin_and_traversal_and_symlink_are_rejected(self):
        with self.assertRaises(DEPLOY.Refusal):
            DEPLOY.extract_source(self.archive, self.root / "bad-pin", "b" * 40)
        for member in (tarfile.TarInfo("pasofi/../../outside"), tarfile.TarInfo("pasofi/unsafe-link")):
            if "link" in member.name:
                member.type = tarfile.SYMTYPE
                member.linkname = "/etc"
            self.write_archive(extra=member)
            with self.assertRaises(DEPLOY.Refusal):
                DEPLOY.extract_source(self.archive, self.root / "unsafe", COMMIT)

    def test_discovery_preserves_ordered_radius_overlay_and_refuses_conflict(self):
        radius = self.root / "radius.yaml"
        radius.write_text("services: {}\n")
        label = DEPLOY.LABEL + "project.config_files"
        self.containers["radius"]["Config"]["Labels"][label] = str(self.compose_file) + "," + str(radius)
        _, files = DEPLOY.discover_stack(self.containers)
        self.assertEqual(files, [str(self.compose_file), str(radius)])
        self.containers["gateway"]["Config"]["Labels"][label] = str(radius) + "," + str(self.compose_file)
        with self.assertRaises(DEPLOY.Refusal):
            DEPLOY.discover_stack(self.containers)

    def test_preflight_has_no_mutating_docker_commands_or_private_release_record(self):
        self.run_plan()
        self.assertIn("Existing Compose project: existing.", self.plan_output.getvalue())
        self.assertFalse(Path(self.args.release_root).exists())
        self.assertTrue(self.commands)
        self.assertFalse(any("run" in cmd or "up" in cmd or "build" in cmd or "down" in cmd for cmd in self.commands))
        self.assertFalse(any(path.name.endswith(".lock") for path in self.root.iterdir()))

    def test_unknown_existing_gate_cannot_disappear(self):
        self.containers["notification"]["Config"]["Env"].append("EXISTING_DELIVERY_QUALIFIED=true")
        with self.assertRaisesRegex(DEPLOY.Refusal, "environment"):
            self.run_plan()

    def test_mount_network_and_port_drift_stop_before_writes(self):
        original = copy.deepcopy(self.containers)
        for kind in ("mount", "network", "port"):
            self.containers = copy.deepcopy(original)
            if kind == "mount":
                self.containers["gateway"]["Mounts"].append({"Destination": "/extra-protected-bind"})
            elif kind == "network":
                self.containers["gateway"]["NetworkSettings"]["Networks"]["unknown-network"] = {}
            else:
                self.containers["gateway"]["HostConfig"]["PortBindings"]["443/tcp"][0]["HostPort"] = "9443"
            with self.subTest(kind=kind), self.assertRaises(DEPLOY.Refusal):
                self.run_plan()

    def test_private_tmpfs_permissions_and_internal_dns_aliases_cannot_disappear(self):
        self.model["services"]["gateway"]["tmpfs"] = ["/tmp"]
        with self.assertRaisesRegex(DEPLOY.Refusal, "tmpfs"):
            self.run_plan()
        self.model["services"]["gateway"]["tmpfs"].append("/run/secrets:mode=0700")
        self.model["services"]["internal-gateway"]["networks"]["services"]["aliases"].remove("prepaid.internal")
        with self.assertRaisesRegex(DEPLOY.Refusal, "DNS aliases"):
            self.run_plan()

    def test_delta_rejects_gate_or_radius_image_change(self):
        source = DEPLOY.extract_source(self.archive, self.root / "source", COMMIT)
        overlay, _ = DEPLOY.plan_overlay(self.model, source, self.manifest["services"], COMMIT, self.containers)
        path = self.root / "upgrade.json"
        path.write_text(json.dumps(overlay))
        after = json.loads(self.compose_result(["-f", str(path)]))
        DEPLOY.verify_delta(self.model, after, overlay)
        self.assertEqual(overlay["services"]["gateway"]["image"], OLD_IMAGE)
        self.assertNotIn("radius-api", overlay["services"])
        after["services"]["notification"]["environment"]["EXISTING_GATE"] = "true"
        with self.assertRaises(DEPLOY.Refusal):
            DEPLOY.verify_delta(self.model, after, overlay)
        after = json.loads(self.compose_result(["-f", str(path)]))
        after["services"]["radius-api"]["image"] = NEW_IMAGE
        with self.assertRaises(DEPLOY.Refusal):
            DEPLOY.verify_delta(self.model, after, overlay)

    def test_apply_only_migrates_owned_services_and_updates_explicit_unprotected_targets(self):
        self.run_plan(apply=True)
        migrations = [cmd[-1] for cmd in self.commands if "run" in cmd]
        self.assertEqual(migrations, ["prepaid-access-migrate", "notification-migrate"])
        updates = [cmd for cmd in self.commands if "up" in cmd]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0][-5:], ["prepaid-access", "notification", "web", "internal-gateway", "gateway"])
        self.assertIn("--no-deps", updates[0])
        self.assertIn("--no-build", updates[0])
        self.assertNotIn("--remove-orphans", updates[0])
        self.assertFalse(any("down" in cmd for cmd in self.commands))
        records = list(Path(self.args.release_root).glob("*/record.json"))
        self.assertEqual(len(records), 1)
        record = json.loads(records[0].read_text())
        self.assertEqual(set(record["protected"]), {"postgres", "radius", "radius-api"})
        self.assertEqual(records[0].stat().st_mode & 0o777, 0o600)
        self.assertTrue(records[0].with_name("completed.json").is_file())

    def test_apply_lock_prevents_overlapping_deployments(self):
        with DEPLOY.apply_lock(self.root, "existing"):
            with self.assertRaisesRegex(DEPLOY.Refusal, "deployment lock"):
                with DEPLOY.apply_lock(self.root, "existing"):
                    self.fail("Second writer acquired the same project lock")

    def test_wrong_final_application_image_cannot_report_success(self):
        original_run = self.fake_run
        def stale_runtime(argv, **kwargs):
            result = original_run(argv, **kwargs)
            if "up" in argv:
                self.containers["prepaid-access"]["Image"] = OLD_IMAGE
            return result
        self.fake_run = stale_runtime
        with self.assertRaisesRegex(DEPLOY.Refusal, "runtime image"):
            self.run_plan(apply=True)
        self.assertFalse(list(Path(self.args.release_root).glob("*/completed.json")))


if __name__ == "__main__":
    unittest.main()
