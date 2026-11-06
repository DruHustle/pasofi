"""CI evidence must belong to the exact packaged commit, not just claim its tree."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('mac_package_evidence', Path(__file__).with_name('build-mac-package.py'))
PACKAGE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PACKAGE)
COMMIT, TREE = 'a' * 40, 'b' * 40


class PackageEvidenceTests(unittest.TestCase):
    def evidence(self):
        return {'source_tree': TREE, 'checks': [
            {'name': name, 'conclusion': 'success', 'url': 'https://github.com/DruHustle/pasofi/actions/runs/123', 'head_sha': COMMIT}
            for name in ('Verify PasoFi', 'Verify Mac deployment launcher')]}

    def read(self, value):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            path.write_text(json.dumps(value))
            return PACKAGE.read_ci(path, COMMIT, TREE)

    def test_exact_commit_and_both_required_successful_checks_qualify(self):
        result = self.read(self.evidence())
        self.assertEqual(result['status'], 'passed_for_pinned_commit')
        self.assertEqual(result['source_commit'], COMMIT)

    def test_unrelated_or_mixed_heads_cannot_borrow_this_tree(self):
        for count in (1, 2):
            value = self.evidence()
            for row in value['checks'][:count]:
                row['head_sha'] = 'c' * 40
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, 'exact packaged commit'):
                self.read(value)

    def test_missing_mac_check_failure_or_wrong_tree_does_not_qualify(self):
        values = [self.evidence() for _ in range(3)]
        values[0]['checks'].pop()
        values[1]['checks'][0]['conclusion'] = 'failure'
        values[2]['source_tree'] = 'd' * 40
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.read(value)

    def test_missing_ci_evidence_remains_unrecorded(self):
        self.assertEqual(PACKAGE.read_ci(None, COMMIT, TREE), {'status': 'not_recorded', 'checks': []})


if __name__ == '__main__':
    unittest.main()
