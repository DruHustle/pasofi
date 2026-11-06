"""Offline orchestration checks: no SSH, server changes or public requests."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from contextlib import ExitStack, redirect_stdout, redirect_stderr


def module(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


auto = module('pasofi-auto.py', 'automatic_test')
post = module('deployment-postcheck.py', 'postcheck_automatic_test')
COMMIT = 'a' * 40
DATABASE_ID = '1234567890123456789'
TARGET = {'schema': 1, 'frontend_origin': 'https://pasofi.onesa.eu', 'backend_origin': 'https://api.pamofi.onesa.eu'}


class AutomaticTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pasofi automatic ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.package = self.root / 'first package'
        self.package.mkdir()
        self.controls = auto.private_directory(self.root / 'durable controls')
        self.results = auto.private_directory(self.package / 'results')
        for name in auto.REQUIRED_FILES:
            (self.package / name).write_text('{}')
        (self.package / 'deployment-target.json').write_text(json.dumps(TARGET))
        self.flags = {service: {key: False for key in gates} for service, gates in post.FLAGS.items()}
        self.baseline = {'project': 'pamofi', 'blockers': [], 'stack': {'compose_files': ['/existing/compose.yml'],
                         'environment_files': ['/existing/live.env']}, 'flags': copy.deepcopy(self.flags),
                         'database_identity': {'status': 'match', 'retained_system_identifier': DATABASE_ID}}
        self.connection = {'selected_alias': 'onesa-portal-worker', 'attempts': [{'alias': 'onesa-portal-worker', 'status': 'connected'}]}
        readiness = SimpleNamespace(load_profile=Mock(return_value={}), automatic_report=Mock(return_value=(self.baseline, self.connection)))
        manifest = {'commit': COMMIT, 'services': list(post.RELEASE_SERVICES), 'migrations': list(post.APPS)}
        engine = SimpleNamespace(load_manifest=Mock(return_value=manifest))
        self.checks = SimpleNamespace(APPS=post.APPS, RELEASE_SERVICES=post.RELEASE_SERVICES,
                                     validate_inputs=post.validate_inputs, remote_report=Mock(return_value={'software_checks_passed': True, 'problems': []}))
        modules = {'hotspot-readiness.py': readiness, 'release-deploy.py': engine, 'deployment-postcheck.py': self.checks}
        self.migrations = {service: {'001_initial.sql': 'b' * 64} for service in post.APPS}
        for patcher in (patch.object(auto, 'ROOT', self.package), patch.object(auto, 'load_module', side_effect=lambda name, _: modules[name]),
                        patch.object(auto, 'migrations_from_archive', return_value=self.migrations)):
            patcher.start()
            self.addCleanup(patcher.stop)
        contexts = ExitStack()
        self.addCleanup(contexts.close)
        self.engine = contexts.enter_context(patch.object(auto, 'run_engine', return_value=0))
        self.public = contexts.enter_context(patch.object(auto, 'public_checks', return_value={'passed': True, 'checks': []}))
        contexts.enter_context(redirect_stdout(io.StringIO()))

    def execute(self, apply=True):
        report = auto.result_report()
        auto.execute(report, self.results, apply=apply, state_root=self.controls)
        return report

    def test_success_is_zero_input_and_never_claims_customer_acceptance(self):
        report = self.execute()
        self.assertTrue(report['software_checks_passed'])
        self.assertFalse(report['customer_ready'])
        self.assertEqual(report['physical_checks'], 'not_performed')
        self.assertEqual([call.kwargs['apply'] for call in self.engine.call_args_list], [False, True])
        completed = next(self.controls.glob('*/completed.json'))
        self.assertEqual(completed.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.controls.glob('*/pending.json')))

    def test_completed_run_and_new_package_copy_only_recheck_original_baseline(self):
        self.execute()
        self.engine.reset_mock()
        self.baseline['flags'] = {service: {key: True for key in gates} for service, gates in self.flags.items()}
        second_results = auto.private_directory(self.root / 'newly extracted package results')
        report = auto.result_report()
        auto.execute(report, second_results, apply=True, state_root=self.controls)
        self.engine.assert_not_called()
        self.assertTrue(report['software_checks_passed'])
        self.assertEqual(self.checks.remote_report.call_args.kwargs['baseline_flags'], self.flags)

    def test_lost_apply_and_interrupt_both_continue_observations_without_retry(self):
        for error in (OSError('SECRET-REMOTE-DIAGNOSTIC'), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                with tempfile.TemporaryDirectory(dir=self.root) as state:
                    controls = Path(state)
                    self.engine.side_effect = [0, error]
                    report = auto.result_report()
                    auto.execute(report, self.results, apply=True, state_root=controls)
                    self.assertEqual(report['application_deployment'], 'uncertain')
                    self.assertIn('deployment_uncertain', report['issues'])
                    self.assertIsNotNone(report['server_postchecks'])
                    self.assertIsNotNone(report['public_postchecks'])
                    self.engine.reset_mock(side_effect=True)
                    self.baseline['flags'] = copy.deepcopy(self.flags)
                    next(iter(self.baseline['flags'].values()))[next(iter(next(iter(self.flags.values()))))] = True
                    second = auto.result_report()
                    auto.execute(second, self.results, apply=True, state_root=controls)
                    self.engine.assert_not_called()
                    self.assertEqual(second['application_deployment'], 'uncertain_previous_operation')
                    self.assertEqual(self.checks.remote_report.call_args.kwargs['baseline_flags'], self.flags)
                    self.assertNotIn('SECRET', json.dumps(report))
                    self.baseline['flags'] = copy.deepcopy(self.flags)

    def test_preflight_accepts_existing_old_source_without_target_postcheck(self):
        report = self.execute(apply=False)
        self.checks.remote_report.assert_not_called()
        self.public.assert_called_once_with(TARGET, require_release=False)
        self.assertEqual(report['application_deployment'], 'preflight_only')
        self.assertFalse(report['software_checks_passed'])
        self.assertEqual(report['issues'], [])
        self.assertEqual([call.kwargs['apply'] for call in self.engine.call_args_list], [False])

    def test_bad_database_identity_and_failed_preflight_never_apply(self):
        self.baseline['database_identity']['status'] = 'mismatch'
        with self.assertRaisesRegex(auto.AutomaticError, 'server_identity_unverified'):
            self.execute()
        self.engine.assert_not_called()
        self.baseline['database_identity']['status'] = 'match'
        self.engine.return_value = 1
        with self.assertRaisesRegex(auto.AutomaticError, 'preflight_failed'):
            self.execute()
        self.assertEqual([call.kwargs['apply'] for call in self.engine.call_args_list], [False])

    def test_postcheck_error_is_sanitized_and_public_checks_still_run(self):
        self.checks.remote_report.side_effect = ValueError('SECRET-CREDENTIAL')
        report = self.execute()
        self.assertIn('postcheck_unavailable', report['issues'])
        self.assertNotIn('SECRET', auto.render_report(report))
        self.public.assert_called_once()

    def test_legacy_and_corrupt_markers_block_apply(self):
        legacy = self.results / ('pending-' + COMMIT + '.json')
        legacy.write_text('old interrupted deployment')
        report = self.execute()
        self.engine.assert_not_called()
        self.assertIn('prior_operation_uncertain', report['issues'])
        flags = self.checks.remote_report.call_args.kwargs['baseline_flags']
        self.assertTrue(all(value == 'unknown' for gates in flags.values() for value in gates.values()))

    def test_html_escapes_remote_and_report_values(self):
        report = auto.result_report()
        report['project'] = '<script>alert(1)</script>'
        report['stages'] = [{'name': '<img src=x>', 'status': '<b>bad</b>'}]
        rendered = auto.render_report(report)
        self.assertNotIn('<script>', rendered)
        self.assertNotIn('<img src=x>', rendered)
        self.assertIn('&lt;script&gt;', rendered)


class PublicBoundaryTests(unittest.TestCase):
    def response(self, url):
        frontend = url.startswith(TARGET['frontend_origin'])
        path = url.split('.eu', 1)[1]
        if path == '/':
            status, data, content_type = 200, b'<!doctype html><title>PasoFi</title>', 'text/html'
        elif path == '/api/capabilities':
            status, content_type = 200, 'application/json'
            data = {'demo': False, 'paymentCheckout': False, 'paymentMode': 'disabled', 'salesLocationStatus': True,
                    'invoices': True, 'routerFleetWrite': False, **{key: True for key in ('staffSales', 'networkAccess', 'vouchers', 'receiptPairing', 'deliverySms')}}
        elif path == '/health/live':
            status, data, content_type = 200, {'status': 'ok', 'service': 'gateway'}, 'application/json'
        elif frontend and path in ('/api/session', '/api/staff/sites'):
            status, data, content_type = 401, {'error': 'not_authenticated'}, 'application/json'
        elif not frontend and path == '/api/session':
            status, data, content_type = 403, {'error': 'proxy_authentication_required'}, 'application/json'
        else:
            status, data, content_type = 404, {'error': 'not_found'}, 'application/json'
        return {'status': status, 'body': data if type(data) is bytes else json.dumps(data).encode(),
                'content_type': content_type, 'sets_cookie': False}

    def test_expected_envelopes_and_real_fleet_write_gate(self):
        result = auto.public_checks(TARGET, fetcher=self.response)
        self.assertTrue(result['passed'])
        self.assertIs(result['capabilities']['routerFleetWrite'], False)

    def test_error_status_alone_extra_data_cookies_and_html_do_not_pass(self):
        for change in ({'body': b'{"error":"wrong"}'}, {'body': b'{"error":"not_authenticated","token":"secret"}'},
                       {'sets_cookie': True}, {'content_type': 'text/html'}, {'status': 302}):
            with self.subTest(change=change):
                def fetch(url):
                    value = self.response(url)
                    if url == TARGET['frontend_origin'] + '/api/session':
                        value.update(change)
                    return value
                result = auto.public_checks(TARGET, fetcher=fetch)
                self.assertFalse(result['passed'])
                self.assertNotIn('secret', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
