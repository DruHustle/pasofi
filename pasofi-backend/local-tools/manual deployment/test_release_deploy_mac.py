"""Offline Mac launcher checks; no SSH connection or deployment is invoked."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
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
        for filename, entry in (("release-deploy.py", "engine"), ("pasofi-auto.py", "automatic")):
            (self.bundle / filename).write_text(
                "import json, os, sys\n"
                "with open(os.environ['PASOFI_MAC_TEST_CALLS'], 'a') as handle:\n"
                "    handle.write(json.dumps({'entry': " + repr(entry) + ", 'args': sys.argv[1:]}) + '\\n')\n"
                "sys.exit(int(os.environ.get('PASOFI_MAC_TEST_EXIT', '0')))\n"
            )
        (self.bundle / "mac-python.sh").write_text(
            "PASOFI_PYTHON=" + shlex.quote(sys.executable) + "\nexport PASOFI_PYTHON\n")
        self.fake_bin = self.root / "offline-bin"
        self.fake_bin.mkdir()
        for name in ("ssh", "scp"):
            tool = self.fake_bin / name
            tool.write_text("#!/bin/sh\nprintf 'Unexpected network invocation\\n' >&2\nexit 99\n")
            tool.chmod(0o755)
        self.environment = dict(os.environ, PASOFI_MAC_TEST_CALLS=str(self.calls),
                                PATH=str(self.fake_bin) + os.pathsep + os.environ["PATH"])
        self.environment.pop("BASH_ENV", None)
        self.environment.pop("ENV", None)

    def invoke(self, args=(), answers="", **environment):
        return subprocess.run(
            ["/bin/bash", str(self.bundle / "release-deploy.command"), *args],
            cwd=self.root, input=answers, text=True, capture_output=True,
            env=dict(self.environment, **environment), timeout=15, check=False,
        )

    def recorded(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_cli_arguments_pass_through_exactly_without_prompts_or_dispatcher(self):
        args = ["--host", "existing-oracle", "--manifest", "relative manifest.json", "--archive", "relative archive.tar.gz",
                "--env-file", "/server/a 'quoted' file.env", "--env-file", "/server/$(touch '" + str(self.marker) + "').env",
                "--expected-database-id", "1234567890123456789", "--apply"]
        result = self.invoke(args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [{"entry": "engine", "args": args}])
        self.assertFalse(self.marker.exists())
        self.assertNotIn("Existing SSH alias", result.stdout)
        self.assertTrue((self.bundle / "release-deploy.command").stat().st_mode & 0o111)

    def test_finder_runs_automatic_apply_with_no_input_or_field_prompts(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [{"entry": "automatic", "args": ["--apply"]}])
        self.assertNotIn("Enter", result.stdout)
        self.assertNotIn("Type APPLY", result.stdout)

    def test_stdin_cannot_supply_or_execute_deployment_fields(self):
        result = self.invoke(answers="$(touch '" + str(self.marker) + "')\nAPPLY\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [{"entry": "automatic", "args": ["--apply"]}])
        self.assertFalse(self.marker.exists())

    def test_dispatcher_failure_preserves_exit_code_without_retry(self):
        result = self.invoke(PASOFI_MAC_TEST_EXIT="32")
        self.assertEqual(result.returncode, 32)
        self.assertEqual(self.recorded(), [{"entry": "automatic", "args": ["--apply"]}])

    def test_incomplete_bundle_stops_before_invocation(self):
        (self.bundle / "pasofi-auto.py").unlink()
        result = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.recorded(), [])
        self.assertIn("automatic Mac package is incomplete", result.stderr)

    def test_python_selection_failure_stops_before_dispatcher(self):
        (self.bundle / "mac-python.sh").write_text("return 23\n")
        result = self.invoke()
        self.assertEqual(result.returncode, 23)
        self.assertEqual(self.recorded(), [])

    def test_automatic_python_does_not_load_user_startup_modules(self):
        custom = self.root / "untrusted-python-path"
        custom.mkdir()
        (custom / "sitecustomize.py").write_text(
            "from pathlib import Path\nPath(" + repr(str(self.marker)) + ").touch()\n")
        result = self.invoke(PYTHONPATH=str(custom))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.recorded(), [{"entry": "automatic", "args": ["--apply"]}])


if __name__ == "__main__":
    unittest.main()
