"""Docker mount enumeration order must not hide or invent runtime drift."""
import copy
import importlib.util
import itertools
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location("runtime_observation", Path(__file__).with_name("release-deploy.py"))
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)


class RuntimeObservationTests(unittest.TestCase):
    def setUp(self):
        self.container = {
            "Id": "original-container", "Image": "sha256:" + "1" * 64,
            "Config": {"Env": ["EXAMPLE=first", "EXAMPLE=last"], "Labels": {"reviewed": "true"}},
            "State": {"Running": True},
            "HostConfig": {"Memory": 123456, "Binds": ["/first:/first:ro", "/second:/second:rw"]},
            "NetworkSettings": {"Networks": {"private": {"Aliases": ["service", "original-container"]}}},
            "Mounts": [
                {"Type": "volume", "Name": "retained-data", "Source": "/volumes/retained-data/_data",
                 "Destination": "/var/lib/postgresql/data", "Driver": "local", "Mode": "rw",
                 "RW": True, "Propagation": "", "FutureAttribute": {"ordered": [1, 2]}},
                {"Type": "bind", "Source": "/private/entrypoint.mjs", "Destination": "/opt/app/entrypoint.mjs",
                 "Mode": "ro", "RW": False, "Propagation": "rprivate"},
                {"Type": "tmpfs", "Destination": "/tmp", "Mode": "", "RW": True, "Propagation": ""},
            ],
        }

    def observations(self, container):
        return (DEPLOY.runtime_digest(container),
                DEPLOY.protected_snapshot({name: container for name in DEPLOY.PROTECTED}))

    def test_all_mount_permutations_preserve_both_observations_and_every_attribute(self):
        original = copy.deepcopy(self.container)
        expected = self.observations(original)
        for permutation in itertools.permutations(original["Mounts"]):
            with self.subTest(destinations=[mount["Destination"] for mount in permutation]):
                candidate = copy.deepcopy(original)
                candidate["Mounts"] = list(permutation)
                before = copy.deepcopy(candidate)
                self.assertEqual(self.observations(candidate), expected)
                self.assertEqual(candidate, before)
        for snapshot in expected[1].values():
            self.assertEqual(snapshot["Mounts"], sorted(original["Mounts"], key=lambda mount: mount["Destination"]))
        self.assertEqual(self.container, original)

    def test_each_mount_attribute_and_membership_change_remains_drift(self):
        expected = self.observations(self.container)
        replacements = {
            "Type": "bind", "Name": "different-data", "Source": "/volumes/different-data/_data",
            "Destination": "/different/data", "Driver": "different-driver", "Mode": "ro",
            "RW": False, "Propagation": "shared", "FutureAttribute": {"ordered": [2, 1]},
        }
        for key, value in replacements.items():
            for operation in ("replace", "remove"):
                with self.subTest(attribute=key, operation=operation):
                    candidate = copy.deepcopy(self.container)
                    if operation == "replace":
                        candidate["Mounts"][0][key] = value
                    else:
                        if key == "Destination":
                            continue  # A missing identity is refused separately.
                        candidate["Mounts"][0].pop(key)
                    candidate["Mounts"].reverse()
                    actual = self.observations(candidate)
                    self.assertNotEqual(actual[0], expected[0])
                    self.assertNotEqual(actual[1], expected[1])
        for operation in ("add", "remove"):
            with self.subTest(operation=operation):
                candidate = copy.deepcopy(self.container)
                if operation == "add":
                    candidate["Mounts"].append({"Type": "tmpfs", "Destination": "/extra", "RW": True})
                else:
                    candidate["Mounts"].pop()
                actual = self.observations(candidate)
                self.assertNotEqual(actual[0], expected[0])
                self.assertNotEqual(actual[1], expected[1])

    def test_missing_malformed_or_duplicate_destinations_are_refused(self):
        duplicate = copy.deepcopy(self.container["Mounts"][0])
        changed_duplicate = {**duplicate, "Source": "/different/source"}
        cases = [None, {}, "invalid", [None], [{}], [{"Destination": None}], [{"Destination": ""}],
                 [{"Destination": 1}], [duplicate, copy.deepcopy(duplicate)], [duplicate, changed_duplicate]]
        for mounts in cases:
            with self.subTest(mounts_type=type(mounts).__name__):
                candidate = copy.deepcopy(self.container)
                candidate["Mounts"] = mounts
                with self.assertRaisesRegex(DEPLOY.Refusal, "mount observations"):
                    DEPLOY.runtime_digest(candidate)
                with self.assertRaisesRegex(DEPLOY.Refusal, "mount observations"):
                    DEPLOY.protected_snapshot({"postgres": candidate})
        self.container.pop("Mounts")
        with self.assertRaisesRegex(DEPLOY.Refusal, "mount observations"):
            DEPLOY.runtime_digest(self.container)
        with self.assertRaisesRegex(DEPLOY.Refusal, "mount observations"):
            DEPLOY.protected_snapshot({"postgres": self.container})

    def test_non_mount_attributes_and_list_order_keep_existing_drift_checks(self):
        expected = self.observations(self.container)
        cases = [
            ("Id", lambda c: c.update(Id="replaced-container")),
            ("Image", lambda c: c.update(Image="sha256:" + "2" * 64)),
            ("HostConfig", lambda c: c["HostConfig"].update(Memory=654321)),
            ("HostConfig", lambda c: c["HostConfig"]["Binds"].reverse()),
            ("NetworkSettings", lambda c: c["NetworkSettings"]["Networks"]["private"]["Aliases"].reverse()),
            ("Config", lambda c: c["Config"]["Env"].reverse()),
            ("Config", lambda c: c["Config"]["Env"].append("UNREVIEWED=true")),
        ]
        for field, mutate in cases:
            with self.subTest(field=field):
                candidate = copy.deepcopy(self.container)
                mutate(candidate)
                actual = self.observations(candidate)
                self.assertNotEqual(actual[0], expected[0])
                if field != "Config":
                    self.assertNotEqual(actual[1], expected[1])
        self.container["State"]["Running"] = False
        self.assertNotEqual(self.observations(self.container)[1], expected[1])

    def test_empty_mounts_remain_valid_and_snapshot_mounts_do_not_alias_inspect(self):
        snapshot = DEPLOY.protected_snapshot({"postgres": self.container})
        original_mounts = copy.deepcopy(snapshot["postgres"]["Mounts"])
        self.container["Mounts"][0]["FutureAttribute"]["ordered"].reverse()
        self.assertEqual(snapshot["postgres"]["Mounts"], original_mounts)
        self.container["Mounts"] = []
        self.assertEqual(DEPLOY.protected_snapshot({"radius": self.container})["radius"]["Mounts"], [])
        self.assertEqual(DEPLOY.runtime_digest(self.container), DEPLOY.runtime_digest(copy.deepcopy(self.container)))


if __name__ == "__main__":
    unittest.main()
