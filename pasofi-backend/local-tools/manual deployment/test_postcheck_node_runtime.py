"""Execute generated diagnostic JavaScript in real Node with isolated fixtures."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('node_runtime_postcheck', Path(__file__).with_name('deployment-postcheck.py'))
POST = importlib.util.module_from_spec(spec)
spec.loader.exec_module(POST)
NODE = shutil.which('node')


@unittest.skipUnless(NODE, 'Node runtime is required for generated-diagnostic qualification')
class NodeRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pasofi node diagnostics ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        package = self.root / 'node_modules/pg'
        package.mkdir(parents=True)
        (package / 'package.json').write_text('{"type":"module","exports":"./index.js"}')
        (package / 'index.js').write_text("""
import fs from 'node:fs';
export default {Client: class {
 constructor(options){this.options=options;this.queries=[];this.fixture=JSON.parse(fs.readFileSync(process.env.PASOFI_TEST_FIXTURE));}
 on(){} async connect(){} async query(sql){this.queries.push(sql);if(sql==='BEGIN READ ONLY'||sql==='ROLLBACK')return {rows:[]};
 if(this.fixture.fail)throw Error('PRIVATE-DATABASE-DETAIL');return {rows:this.fixture.rows};}
 async end(){fs.writeFileSync(process.env.PASOFI_TEST_QUERIES,JSON.stringify(this.queries));}
}};
""")
        self.fixture = self.root / 'fixture.json'
        self.queries = self.root / 'queries.json'
        url = self.root / 'database-url'
        url.write_text('postgresql://fixture:PRIVATE-TEST-PASSWORD@invalid/pamofi')
        self.env = dict(os.environ, DATABASE_URL_FILE=str(url), PASOFI_TEST_FIXTURE=str(self.fixture), PASOFI_TEST_QUERIES=str(self.queries))
        self.fixture.write_text('{"rows":[]}')

    def execute(self, argv, **kwargs):
        self.assertEqual(argv[:2], ['docker', 'exec'])
        result = subprocess.run([NODE, '--input-type=module', '-e', argv[-1]], cwd=self.root,
                                env=self.env, capture_output=True, text=True, timeout=15, check=False)
        self.assertNotIn('PRIVATE-', result.stdout + result.stderr)
        if result.returncode:
            raise POST.PostcheckError('diagnostic_unavailable')
        return result.stdout

    def test_actual_migration_program_handles_match_missing_changed_and_invalid_rows(self):
        expected = {'001_initial.sql': 'b' * 64}
        cases = [([{'name': '001_initial.sql', 'checksum': 'b' * 64}], 'match'), ([], 'mismatch'),
                 ([{'name': '001_initial.sql', 'checksum': 'c' * 64}], 'mismatch'),
                 ([{'name': '001_initial.sql', 'checksum': 'b' * 64}, {'name': '002_extra.sql', 'checksum': 'd' * 64}], 'mismatch')]
        with patch.object(POST, 'command', side_effect=self.execute):
            for rows, status in cases:
                self.fixture.write_text(json.dumps({'rows': rows}))
                self.assertEqual(POST.migration_check({'Id': 'isolated-fixture'}, expected)['status'], status)
                self.assertEqual(json.loads(self.queries.read_text())[0], 'BEGIN READ ONLY')
                self.assertEqual(json.loads(self.queries.read_text())[-1], 'ROLLBACK')
            for rows in ([{'name': '../bad', 'checksum': 'b' * 64}], cases[0][0] * 2):
                self.fixture.write_text(json.dumps({'rows': rows}))
                with self.assertRaises(POST.PostcheckError):
                    POST.migration_check({'Id': 'isolated-fixture'}, expected)

    def test_actual_queue_program_and_exception_paths_do_not_emit_private_data(self):
        with patch.object(POST, 'command', side_effect=self.execute):
            for service, fields in POST.QUEUE_FIELDS.items():
                self.fixture.write_text(json.dumps({'rows': [{field: 0 for field in fields}]}))
                self.assertEqual(POST.aggregate({'Id': 'isolated-fixture'}, service)['status'], 'observed')
            self.fixture.write_text('{"fail":true}')
            with self.assertRaises(POST.PostcheckError):
                POST.aggregate({'Id': 'isolated-fixture'}, next(iter(POST.QUEUE_FIELDS)))

    def test_actual_http_program_checks_envelopes_redirects_body_limit_and_cookies(self):
        responses = {
            '/ok': (401, {'Content-Type': 'application/json'}, b'{"error":"unauthorized"}'),
            '/wrong': (401, {'Content-Type': 'application/json'}, b'{"error":"wrong"}'),
            '/extra': (401, {'Content-Type': 'application/json'}, b'{"error":"unauthorized","private":"not-logged"}'),
            '/cookie': (401, {'Content-Type': 'application/json', 'Set-Cookie': 'session=x'}, b'{"error":"unauthorized"}'),
            '/large': (401, {'Content-Type': 'application/json'}, b' ' * 4097),
            '/redirect': (302, {'Location': '/ok'}, b''),
            '/html': (401, {'Content-Type': 'text/html'}, b'<html>not an API denial</html>'),
        }
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                status, headers, body = responses[self.path]
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            checks = [[name[1:], 'http://127.0.0.1:' + str(server.server_port) + name, 401, 'json', {'error': 'unauthorized'}] for name in responses]
            result = subprocess.run([NODE, '--input-type=module', '-e', POST.http_program(checks)],
                                    cwd=self.root, capture_output=True, text=True, timeout=15, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            actual = json.loads(result.stdout)
            self.assertEqual(actual.pop('ok'), 'passed')
            self.assertTrue(all(value == 'unavailable' for value in actual.values()))
            self.assertNotIn('not-logged', result.stdout + result.stderr)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
