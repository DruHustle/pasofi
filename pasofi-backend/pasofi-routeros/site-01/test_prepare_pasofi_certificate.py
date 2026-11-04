import importlib.util
from pathlib import Path
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).with_name('prepare-pasofi-certificate.py')
spec = importlib.util.spec_from_file_location('pasofi_cert', MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BundleTest(unittest.TestCase):
    def test_encrypted_bundle_is_validated_and_failed_checks_remove_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            key, cert = root / 'key.pem', root / 'cert.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(key), '-out', str(cert), '-days', '30',
                            '-subj', '/CN=hotspot.pasofi.onesa.eu',
                            '-addext', 'subjectAltName=DNS:hotspot.pasofi.onesa.eu'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            pem = cert.read_bytes()
            fingerprint = module.run(['openssl', 'x509', '-noout', '-fingerprint', '-sha256'], pem).stdout.decode().strip().split('=')[-1].replace(':', '')
            password = 'temporary-test-passphrase-only'
            payload = module.run(['openssl', 'pkcs12', '-export', '-in', str(cert), '-inkey', str(key),
                                  '-certfile', str(cert), '-passout', 'stdin'], (password + '\n').encode()).stdout
            real_run = module.run
            def fake_run(args, data, timeout=60):
                if args[0] == 'ssh':
                    self.assertEqual(data, (password + '\n').encode())
                    return subprocess.CompletedProcess(args, 0, payload, b'')
                return real_run(args, data, timeout)
            with patch.object(module, 'run', side_effect=fake_run):
                result = module.make_bundle(password, expected=fingerprint, parent=temp)
                self.assertEqual(os.stat(result).st_mode & 0o777, 0o600)
                self.assertEqual(os.stat(result.parent).st_mode & 0o777, 0o700)
                with self.assertRaisesRegex(ValueError, 'fingerprint'):
                    module.make_bundle(password, expected='wrong', parent=temp)
                self.assertEqual(len(list(root.glob('pasofi-hotspot-*'))), 1)
                with self.assertRaisesRegex(ValueError, 'at least 20'):
                    module.make_bundle('short', expected=fingerprint, parent=temp)


if __name__ == '__main__':
    unittest.main()
