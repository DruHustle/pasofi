"""Real local filesystem smoke, also run on the macOS CI runner."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mac_state_automatic', Path(__file__).with_name('pasofi-auto.py'))
AUTO = importlib.util.module_from_spec(spec)
spec.loader.exec_module(AUTO)


class MacStateTests(unittest.TestCase):
    def test_real_private_file_and_parent_directory_fsync(self):
        with tempfile.TemporaryDirectory(prefix='PasoFi state ') as temporary:
            root = AUTO.private_directory(Path(temporary) / 'private')
            target = root / 'pending.json'
            AUTO.write_private(target, {'schema': 1, 'operation': 'fixture only'})
            self.assertEqual(json.loads(target.read_text()), {'schema': 1, 'operation': 'fixture only'})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError):
                AUTO.write_private(target, {})

    def test_state_root_is_stable_and_does_not_follow_links(self):
        with tempfile.TemporaryDirectory(prefix='PasoFi Mac home ') as temporary:
            home = Path(temporary)
            with patch.object(AUTO.Path, 'home', return_value=home):
                first = AUTO.durable_state_root()
                self.assertEqual(first, AUTO.durable_state_root())
                self.assertEqual(first, home / 'Library/Application Support/PasoFi/Deployments')
                first.rmdir()
                target = home / 'untrusted-state'
                target.mkdir()
                first.symlink_to(target, target_is_directory=True)
                with self.assertRaises(AUTO.AutomaticError):
                    AUTO.durable_state_root()


if __name__ == '__main__':
    unittest.main()
