"""Exercise approved bind overlays through the real Compose config renderer."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("compose_delta_fixture", Path(__file__).with_name("test_release_deploy.py"))
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)
DEPLOY = FIXTURE.DEPLOY


class ComposeRendererDeltaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        supplied = os.environ.get("PASOFI_COMPOSE_BINARY")
        if supplied:
            cls.compose = [supplied]
        elif shutil.which("docker-compose"):
            cls.compose = [shutil.which("docker-compose")]
        elif shutil.which("docker"):
            cls.compose = [shutil.which("docker"), "compose"]
        else:
            raise unittest.SkipTest("Install Compose or set PASOFI_COMPOSE_BINARY for renderer integration checks")
        result = subprocess.run([*cls.compose, "version", "--short"], capture_output=True, timeout=10, check=False)
        if result.returncode:
            raise RuntimeError("The selected Compose renderer is unavailable")

    def setUp(self):
        self.fixture = FIXTURE.ReleaseSafetyTests("runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        fixture = self.fixture
        self.base_path = fixture.root / "baseline.compose.json"
        DEPLOY.write_compose(self.base_path, fixture.model)
        base = DEPLOY.compose_command("existing", fixture.root, [str(self.base_path)], [str(fixture.env_file)])
        source = DEPLOY.extract_source(fixture.archive, fixture.root / "source", FIXTURE.COMMIT)
        self.overlay_path = fixture.root / "upgrade.compose.json"
        with patch.object(DEPLOY, "run", side_effect=self.render):
            self.before = DEPLOY.resolved_compose(base)
            self.overlay, _ = DEPLOY.plan_overlay(self.before, source, fixture.manifest["services"],
                                                  FIXTURE.COMMIT, fixture.containers)
            DEPLOY.write_compose(self.overlay_path, self.overlay)
            self.after = DEPLOY.resolved_compose(base + ["-f", str(self.overlay_path)])
        self.service, self.replacement = next((name, volume) for name, change in self.overlay["services"].items()
                                             for volume in change.get("volumes", []))

    def render(self, argv, *, cwd=None, log=None):
        self.assertIsNone(cwd)
        self.assertIsNone(log)
        self.assertEqual(argv[:2], ["docker", "compose"])
        self.assertEqual(argv[-3:], ["config", "--format", "json"])
        # An absent socket proves these tests need no Docker daemon and cannot
        # reach an existing installation. All configuration is synthetic.
        environment = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C",
                       "DOCKER_HOST": "unix://" + str(self.fixture.root / "absent-docker.sock"),
                       "DOCKER_CONFIG": str(self.fixture.root / "empty-docker-config")}
        result = subprocess.run([*self.compose, *argv[2:]], capture_output=True, timeout=15,
                                check=False, env=environment)
        self.assertEqual(result.returncode, 0, "Synthetic Compose config rendering failed")
        return result.stdout.decode()

    def matching_volume(self, model):
        return next(volume for volume in model["services"][self.service]["volumes"]
                    if volume["target"] == self.replacement["target"])

    def test_real_renderer_preserves_explicit_no_create_overlay_and_passes_delta(self):
        original = copy.deepcopy((self.before, self.after, self.overlay))
        emitted = self.overlay_path.read_bytes()
        parsed_overlay = json.loads(emitted)
        for name, change in parsed_overlay["services"].items():
            for replacement in change.get("volumes", []):
                self.assertIs(replacement["bind"]["create_host_path"], False)
                observed = next(volume for volume in self.after["services"][name]["volumes"]
                                if volume["target"] == replacement["target"])
                self.assertIs(observed["bind"].get("create_host_path", False), False)
        DEPLOY.verify_delta(self.before, self.after, self.overlay)
        self.assertEqual((self.before, self.after, self.overlay), original)
        self.assertEqual(self.overlay_path.read_bytes(), emitted)

    def test_false_omission_cannot_hide_real_mount_or_other_configuration_changes(self):
        changes = [
            ("create_true", lambda model: self.matching_volume(model)["bind"].update(create_host_path=True)),
            ("create_string", lambda model: self.matching_volume(model)["bind"].update(create_host_path="false")),
            ("create_zero", lambda model: self.matching_volume(model)["bind"].update(create_host_path=0)),
            ("create_null", lambda model: self.matching_volume(model)["bind"].update(create_host_path=None)),
            ("writable", lambda model: self.matching_volume(model).update(read_only=False)),
            ("source", lambda model: self.matching_volume(model).update(source="/unreviewed/source")),
            ("target", lambda model: self.matching_volume(model).update(target="/unreviewed/target")),
            ("type", lambda model: self.matching_volume(model).update(type="volume")),
            ("propagation", lambda model: self.matching_volume(model)["bind"].update(propagation="shared")),
            ("missing_bind", lambda model: self.matching_volume(model).pop("bind")),
            ("image", lambda model: model["services"][self.service].update(image="unreviewed/image:latest")),
            ("environment", lambda model: model["services"][self.service]["environment"].update(EXISTING_GATE="true")),
            ("extra_mount", lambda model: model["services"][self.service]["volumes"].append({"type": "tmpfs", "target": "/extra"})),
            ("migration_mount_order", lambda model: model["services"]["network-migrate"]["volumes"].reverse()),
            ("protected_volume", lambda model: model["services"]["postgres"]["volumes"][0].update(source="different-data")),
        ]
        for name, mutate in changes:
            with self.subTest(change=name):
                candidate = copy.deepcopy(self.after)
                mutate(candidate)
                with self.assertRaises(DEPLOY.Refusal):
                    DEPLOY.verify_delta(self.before, candidate, self.overlay)

    def test_omission_is_not_normalized_on_unapproved_or_protected_mounts(self):
        for name in (self.service, "radius"):
            with self.subTest(service=name):
                before, after = copy.deepcopy(self.before), copy.deepcopy(self.after)
                unapproved = {"type": "bind", "source": "/unchanged/source", "target": "/unchanged/target",
                              "read_only": True, "bind": {"create_host_path": False}}
                before["services"][name].setdefault("volumes", []).append(unapproved)
                after["services"][name].setdefault("volumes", []).append(copy.deepcopy(unapproved))
                after["services"][name]["volumes"][-1]["bind"].pop("create_host_path")
                with self.assertRaises(DEPLOY.Refusal):
                    DEPLOY.verify_delta(before, after, self.overlay)


if __name__ == "__main__":
    unittest.main()
