"""Offline Mac launcher safety checks; the real deployment engine is not invoked."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class MacLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pasofi Mac release test ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "Extracted Release With Spaces"
        self.bundle.mkdir()
        source = Path(__file__).parent
        for name in ("release-deploy.command", "release-deploy.sh"):
            shutil.copy2(source / name, self.bundle / name)
        self.calls = self.root / "calls.jsonl"
        self.marker = self.root / "input-was-executed"
        (self.bundle / "release.json").write_text("{}\n")
        (self.bundle / "source.tar.gz").write_bytes(b"synthetic archive: never opened")
        (self.bundle / "release-deploy.py").write_text(
            "import json, os, sys\n"
            "with open(os.environ['PASOFI_MAC_TEST_CALLS'], 'a') as handle:\n"
            "    handle.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "mode = 'APPLY' if '--apply' in sys.argv else 'PREFLIGHT'\n"
            "sys.exit(int(os.environ.get('PASOFI_MAC_TEST_' + mode + '_EXIT', '0')))\n"
        )
        self.fake_bin = self.root / "offline-bin"
        self.fake_bin.mkdir()
        for name in ("ssh", "scp"):
            tool = self.fake_bin / name
            tool.write_text("#!/bin/sh\nprintf 'Unexpected network invocation\\n' >&2\nexit 99\n")
            tool.chmod(0o755)
        self.environment = dict(os.environ, PASOFI_MAC_TEST_CALLS=str(self.calls),
                                PATH=str(self.fake_bin) + os.pathsep + os.environ["PATH"])
        # Keep workstation shell startup hooks out of this isolated launcher check.
        self.environment.pop("BASH_ENV", None)
        self.environment.pop("ENV", None)
        self.host = "existing-oracle"
        self.env_files = ["/server/existing/production.env", "/server/existing/qualified overlays.env"]
        self.database_id = "1234567890123456789"

    def invoke(self, args=(), answers="", **environment):
        return subprocess.run(
            ["/bin/bash", str(self.bundle / "release-deploy.command"), *args],
            cwd=self.root, input=answers, text=True, capture_output=True,
            env=dict(self.environment, **environment), timeout=15, check=False,
        )

    def recorded(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def answers(self, confirmation="APPLY", project="", files=None):
        values = [self.host, *(self.env_files if files is None else files), "", self.database_id, project]
        if confirmation is not None:
            values.append(confirmation)
        return "\n".join(values) + "\n"

    def expected(self, project="", files=None):
        args = ["--host", self.host, "--manifest", str(self.bundle / "release.json"),
                "--archive", str(self.bundle / "source.tar.gz")]
        for path in self.env_files if files is None else files:
            args.extend(["--env-file", path])
        args.extend(["--expected-database-id", self.database_id])
        if project:
            args.extend(["--project", project])
        return args

    def test_cli_arguments_pass_through_exactly_without_interactive_prompts(self):
        args = ["--host", self.host, "--manifest", "relative manifest.json", "--archive", "relative archive.tar.gz",
                "--env-file", "/server/a 'quoted' file.env", "--env-file", "/server/$(printf literal).env",
                "--expected-database-id", self.database_id, "--apply"]
        result = self.invoke(args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [args])
        self.assertNotIn("Existing SSH alias", result.stdout)
        self.assertTrue((self.bundle / "release-deploy.command").stat().st_mode & 0o111)

    def test_interactive_apply_reuses_preflight_inputs_and_never_evaluates_paths(self):
        files = [self.env_files[1], "/server/$(touch '" + str(self.marker) + "').env"]
        result = self.invoke(answers=self.answers(project="existing-production", files=files))
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = self.expected(project="existing-production", files=files)
        self.assertEqual(self.recorded(), [expected, [*expected, "--apply"]])
        self.assertFalse(self.marker.exists())

    def test_only_exact_apply_confirmation_can_start_apply(self):
        for confirmation in ("", "apply", "APPLY ", None):
            with self.subTest(confirmation=confirmation):
                self.calls.unlink(missing_ok=True)
                result = self.invoke(answers=self.answers(confirmation=confirmation))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.recorded(), [self.expected()])

    def test_failed_preflight_never_offers_or_runs_apply(self):
        result = self.invoke(answers=self.answers(), PASOFI_MAC_TEST_PREFLIGHT_EXIT="31")
        self.assertEqual(result.returncode, 31)
        self.assertEqual(self.recorded(), [self.expected()])
        self.assertNotIn("Type APPLY", result.stdout)

    def test_apply_failure_keeps_exit_status_and_explains_partial_completion(self):
        result = self.invoke(answers=self.answers(), PASOFI_MAC_TEST_APPLY_EXIT="32")
        self.assertEqual(result.returncode, 32)
        self.assertEqual(self.recorded(), [self.expected(), [*self.expected(), "--apply"]])
        self.assertIn("Some operations may have completed", result.stderr)


if __name__ == "__main__":
    unittest.main()
