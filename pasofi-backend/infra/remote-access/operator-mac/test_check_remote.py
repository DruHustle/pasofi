"""Synthetic local tests. No live router, hub, tailnet, browser or VPN changes."""

import copy
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("check_remote", Path(__file__).with_name("check_remote.py"))
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)


def manifest():
    return {"schemaVersion": 1, "kind": "pasofi-owner-management", "status": "prepared-only",
            "planId": "synthetic-test", "expectedTailscaleLogin": "owner@example.net", "expectedHubNodeId": "nSyntheticHub123",
            "requiredRoutes": ["10.99.254.2/32", "192.168.209.2/32"], "targets": [
                {"id": "gateway-a", "name": "Synthetic gateway A", "role": "gateway", "gatewayId": "gateway-a", "vendor": "mikrotik",
                 "address": "10.99.254.2", "tcpPorts": [80, 8291], "icmp": False,
                 "expectedIdentity": {"kind": "serial", "value": "SYNTHETIC-0001"}, "verifiedAt": "2026-11-06T12:00:00Z"},
                {"id": "bridge-a", "name": "Synthetic bridge A", "role": "downstream", "gatewayId": "gateway-a", "vendor": "tenda",
                 "address": "192.168.209.2", "tcpPorts": [80], "icmp": False,
                 "expectedIdentity": {"kind": "mac", "value": "02:00:00:00:00:02"}, "verifiedAt": "2026-11-06T12:00:00.000Z"}]}


IFCONFIG = """lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.50.30 netmask 0xffffff00 broadcast 192.168.50.255
\tstatus: active
en7: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tstatus: inactive
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet 100.70.80.90 --> 100.70.80.90 netmask 0xffffffff
"""
HARDWARE = """Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 02:00:00:00:00:11

Hardware Port: USB 10/100 LAN
Device: en7
Ethernet Address: 02:00:00:00:00:12
"""


def snapshot():
    return {"macOS": "15.7", "variant": "standalone", "interfaces": check.parse_interfaces(IFCONFIG),
            "hardware": check.parse_hardware(HARDWARE), "defaultRoute": {"interface": "en0", "destination": "default", "gateway": "192.168.50.1"},
            "tailscale": {"BackendState": "Running", "Self": {"ID": "nSyntheticMac", "UserID": 17, "Online": True,
                                                            "TailscaleIPs": ["100.70.80.90", "fd7a:115c:a1e0::1234"]},
                          "User": {"17": {"LoginName": "owner@example.net"}}, "AuthURL": "SECRET_AUTH_URL_NOT_FOR_REPORT",
                          "Peer": {"nodekey:synthetic": {"ID": "nSyntheticHub123", "Online": True,
                                                        "PrimaryRoutes": manifest()["requiredRoutes"], "HostName": "SECRET_OTHER_NODE_METADATA"}}}}


class FakeSystem:
    def __init__(self, first=None, last=None, routes=None):
        self.first = first or snapshot()
        self.last = last or self.first
        self.routes = routes or {}
        self.calls = []
        self.observations = 0

    def observe(self):
        self.observations += 1
        return copy.deepcopy(self.first if self.observations == 1 else self.last)

    def route(self, address):
        self.calls.append(address)
        value = self.routes.get(address, "utun4")
        if isinstance(value, list):
            value = value.pop(0)
        return {"interface": value, "destination": address, "gateway": "link#20"}


def passing_probe(*args):
    result = {"port": args[1], "tcp": "connected"}
    if args[1] in (80, 443):
        result["http"] = {"status": "response-received", "statusCode": 200, "deviceIdentityVerified": False}
    return result


class ManifestTests(unittest.TestCase):
    def test_exact_contract_and_invalid_public_secret_or_scan_inputs(self):
        self.assertEqual(check.validate_manifest(manifest()), manifest())
        changes = [
            lambda v: v.update(token="SECRET"),
            lambda v: v.update(schemaVersion=True),
            lambda v: v.update(expectedTailscaleLogin="owner@arbitrary-bare-suffix"),
            lambda v: v.update(expectedTailscaleLogin="owner@192.168.1.1"),
            lambda v: v.update(expectedTailscaleLogin="owner@-bad.example.net"),
            lambda v: v["targets"][0].update(address="8.8.8.8"),
            lambda v: v["targets"][0].update(address="192.168.050.1"),
            lambda v: v["targets"][0].update(tcpPorts=[80, 8728]),
            lambda v: v["targets"][0].update(tcpPorts=[True]),
            lambda v: v["targets"][0].update(tcpPorts=[80, 80]),
            lambda v: v.update(requiredRoutes=["0.0.0.0/0"]),
            lambda v: v["targets"][0].update(verifiedAt="2026-02-30T12:00:00Z"),
            lambda v: v["targets"][0].update(verifiedAt="2026-11-06T12:00:00+00:00"),
            lambda v: v["targets"][0].update(name="line\ncommand"),
            lambda v: v["targets"][0].update(name="   "),
            lambda v: v["targets"][0].update(name="\ud800"),
            lambda v: v["targets"][1].update(expectedIdentity={"kind": "mac", "value": "00:00:00:00:00:00"}),
            lambda v: v["targets"][1].update(expectedIdentity={"kind": "mac", "value": "01:00:00:00:00:01"}),
            lambda v: v["targets"][1].update(expectedIdentity=v["targets"][0]["expectedIdentity"]),
            lambda v: v["targets"][1].update(expectedIdentity={"kind": "serial", "value": "synthetic-0001"}),
            lambda v: v["targets"][1].update(gatewayId="not-enrolled"),
            lambda v: v["targets"][1].update(address=v["targets"][0]["address"]),
        ]
        for change in changes:
            value = manifest()
            change(value)
            with self.subTest(change=change), self.assertRaises(check.CheckError):
                check.validate_manifest(value)

    def test_private_manifest_and_duplicate_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "owner-targets.json"
            path.write_text(json.dumps(manifest()), encoding="utf-8")
            path.chmod(0o600)
            self.assertEqual(check.read_manifest(path)["planId"], "synthetic-test")
            path.chmod(0o644)
            with self.assertRaises(check.CheckError):
                check.read_manifest(path)
            path.chmod(0o600)
            link = Path(directory) / "link.json"
            link.symlink_to(path)
            with self.assertRaises(check.CheckError):
                check.read_manifest(link)
            pipe = Path(directory) / "not-a-regular-file.json"
            os.mkfifo(str(pipe), 0o600)
            with self.assertRaises(check.CheckError):
                check.read_manifest(pipe)
        for raw in ('{"a":1,"a":2}', '{"a":NaN}'):
            with self.assertRaises(check.CheckError):
                check.strict_json(raw)

    def test_provider_logins_are_identities_not_public_endpoint_hostnames(self):
        for login in ("owner@github", "owner@passkey", "owner@company.test", "owner@company.local", "owner@example.net"):
            with self.subTest(login=login):
                value = manifest()
                value["expectedTailscaleLogin"] = login
                self.assertEqual(check.validate_manifest(value)["expectedTailscaleLogin"], login)


class RouteAndIdentityTests(unittest.TestCase):
    def test_all_transport_success_never_qualifies_identity_or_offsite(self):
        probe = mock.Mock(side_effect=passing_probe)
        report = check.perform_check(manifest(), FakeSystem(), probe=probe, different_wifi=True)
        self.assertTrue(report["allListedTcpPortsReachable"])
        self.assertEqual(probe.call_count, 3)
        self.assertFalse(report["qualification"]["qualified"])
        self.assertEqual(report["qualification"]["authenticatedDeviceIdentities"], "pending")
        self.assertEqual(report["qualification"]["policyDenialTests"], "pending")
        self.assertEqual(report["qualification"]["reconnectTests"], "pending")
        self.assertEqual(report["network"]["differentWifi"], "operator-reported")
        self.assertFalse(report["network"]["offSiteIndependentlyVerified"])
        self.assertTrue(report["network"]["wifiDefaultAndNoWiredInterfaceObserved"])
        for target in report["targets"]:
            self.assertEqual(target["identity"], "pending-authenticated-ui-check")
        self.assertNotIn("SECRET", json.dumps(report))

    def test_login_hub_routes_and_utun_ambiguity_prevent_all_probes(self):
        def remove_route_status(s):
            del s["tailscale"]["Peer"]["nodekey:synthetic"]["PrimaryRoutes"]
        changes = [
            lambda s: s["tailscale"]["User"]["17"].update(LoginName="someone-else@example.test"),
            lambda s: s["tailscale"].update(BackendState="NeedsLogin"),
            lambda s: s["tailscale"]["Self"].update(UserID=True),
            lambda s: s["tailscale"]["Self"].update(Online=False),
            lambda s: s["tailscale"]["Self"].update(Expired=True),
            lambda s: s["tailscale"]["Peer"]["nodekey:synthetic"].update(ID="wrong-hub"),
            lambda s: s["tailscale"]["Peer"]["nodekey:synthetic"].update(Online=False),
            lambda s: s["tailscale"]["Peer"].update(duplicate=copy.deepcopy(s["tailscale"]["Peer"]["nodekey:synthetic"])),
            lambda s: s["tailscale"].update(ExitNodeStatus={"ID": "an-exit-node"}),
            remove_route_status,
            lambda s: s["interfaces"]["utun4"].update(ipv4=[]),
            lambda s: s["interfaces"].update(utun5=copy.deepcopy(s["interfaces"]["utun4"])),
        ]
        for change in changes:
            value = snapshot()
            change(value)
            probe = mock.Mock(side_effect=passing_probe)
            with self.subTest(change=change):
                report = check.perform_check(manifest(), FakeSystem(value), probe=probe)
                self.assertFalse(report["allListedTcpPortsReachable"])
                self.assertTrue(report["issues"])
                probe.assert_not_called()

    def test_winning_vpn_host_route_does_not_override_local_subnet_conflict(self):
        value = snapshot()
        value["interfaces"]["en0"]["ipv4"] = [{"address": "192.168.209.50", "network": "192.168.209.0/24"}]
        probe = mock.Mock(side_effect=passing_probe)
        report = check.perform_check(manifest(), FakeSystem(value), probe=probe)
        self.assertEqual(probe.call_count, 2)
        self.assertIn("overlaps", report["targets"][1]["blockedReason"])
        self.assertFalse(report["allListedTcpPortsReachable"])

    def test_actual_local_route_wrong_utun_and_wrong_primary_hub_are_blocked(self):
        for interface in ("en0", "utun999"):
            with self.subTest(interface=interface):
                probe = mock.Mock(side_effect=passing_probe)
                report = check.perform_check(manifest(), FakeSystem(routes={"192.168.209.2": interface}), probe=probe)
                self.assertEqual(probe.call_count, 2)
                self.assertIn("actual macOS route", report["targets"][1]["blockedReason"])
        for mutate in (lambda s: s["tailscale"]["Peer"]["nodekey:synthetic"].update(PrimaryRoutes=["10.99.254.2/32"]),
                       lambda s: s["tailscale"]["Peer"].update(other={"ID": "another-hub", "PrimaryRoutes": ["192.168.209.2/32"]})):
            value = snapshot()
            mutate(value)
            probe = mock.Mock(side_effect=passing_probe)
            report = check.perform_check(manifest(), FakeSystem(value), probe=probe)
            self.assertEqual(probe.call_count, 2)
            self.assertIn("unique current primary", report["targets"][1]["blockedReason"])

    def test_route_rechecked_before_each_port_and_account_rechecked_at_end(self):
        probe = mock.Mock(side_effect=passing_probe)
        system = FakeSystem(routes={"10.99.254.2": ["utun4", "utun4", "en0"]})
        report = check.perform_check(manifest(), system, probe=probe)
        self.assertEqual([call.args[1] for call in probe.call_args_list], [80, 80])
        self.assertFalse(report["allListedTcpPortsReachable"])
        final = snapshot()
        final["tailscale"]["User"]["17"]["LoginName"] = "changed@example.test"
        report = check.perform_check(manifest(), FakeSystem(last=final), probe=passing_probe)
        self.assertFalse(report["vpn"]["stateStableDuringCheck"])
        self.assertFalse(report["allListedTcpPortsReachable"])

    def test_wifi_without_cable_is_not_external_evidence_and_wired_is_reported(self):
        report = check.perform_check(manifest(), FakeSystem(), probe=passing_probe)
        self.assertEqual(report["network"]["differentWifi"], "not-confirmed")
        self.assertFalse(report["network"]["offSiteIndependentlyVerified"])
        value = snapshot()
        value["interfaces"]["en7"]["active"] = True
        report = check.perform_check(manifest(), FakeSystem(value), probe=passing_probe, different_wifi=True)
        self.assertEqual(report["network"]["activeWiredOrOtherInterfaces"], ["en7"])
        self.assertFalse(report["network"]["wifiDefaultAndNoWiredInterfaceObserved"])

    def test_unknown_format_and_exhausted_time_fail_without_probes(self):
        for raw in ("no interface", "en0: flags=8863<UP,RUNNING>\n\tinet malformed"):
            with self.assertRaises(check.CheckError):
                check.parse_interfaces(raw)
        with self.assertRaises(check.CheckError):
            check.parse_route("route to: 192.168.209.2\ninterface: en0\nflags: <UP,REJECT>", "192.168.209.2")
        with mock.patch.object(check, "CHECK_SECONDS", 0):
            probe = mock.Mock(side_effect=passing_probe)
            report = check.perform_check(manifest(), FakeSystem(), probe=probe)
            probe.assert_not_called()
            self.assertFalse(report["allListedTcpPortsReachable"])


class ProbeAndPrivacyTests(unittest.TestCase):
    def fake_socket(self, response=b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\nSECRET_BODY"):
        stream = mock.Mock()
        stream.recv.side_effect = [response, b""]
        return stream

    def test_interface_and_source_bound_before_connect_and_no_redirect_or_cookie(self):
        stream = self.fake_socket(b"HTTP/1.1 302 Found\r\nLocation: http://192.168.209.99/login?token=SECRET\r\nSet-Cookie: auth=SECRET\r\n\r\nSECRET_BODY")
        with mock.patch.object(check.socket, "socket", return_value=stream), mock.patch.object(check.socket, "if_nametoindex", return_value=20):
            result = check.probe_target("192.168.209.2", 80, "utun4", "100.70.80.90", time.monotonic() + 20)
        calls = [call[0] for call in stream.method_calls]
        self.assertLess(calls.index("setsockopt"), calls.index("bind"))
        self.assertLess(calls.index("bind"), calls.index("connect"))
        stream.setsockopt.assert_called_once_with(socket.IPPROTO_IP, check.IP_BOUND_IF, 20)
        stream.bind.assert_called_once_with(("100.70.80.90", 0))
        stream.connect.assert_called_once_with(("192.168.209.2", 80))
        self.assertFalse(result["http"]["redirectFollowed"])
        self.assertEqual(result["http"]["redirect"], "different-origin")
        self.assertNotIn("SECRET", json.dumps(result))
        sent = stream.sendall.call_args.args[0]
        self.assertTrue(sent.startswith(b"GET / HTTP/1.1\r\n"))
        self.assertNotIn(b"Authorization", sent)
        self.assertNotIn(b"Cookie", sent)
        self.assertNotIn(b"Proxy", sent)

    def test_binding_failure_never_falls_back_and_nonweb_ports_receive_no_payload(self):
        for failing_method in ("setsockopt", "bind"):
            stream = self.fake_socket()
            getattr(stream, failing_method).side_effect = OSError("SECRET_SYSTEM_ERROR")
            with mock.patch.object(check.socket, "socket", return_value=stream), mock.patch.object(check.socket, "if_nametoindex", return_value=20):
                result = check.probe_target("10.99.254.2", 8291, "utun4", "100.70.80.90", time.monotonic() + 20)
            stream.connect.assert_not_called()
            self.assertNotIn("SECRET", json.dumps(result))
        for port in (22, 8291):
            stream = self.fake_socket()
            with mock.patch.object(check.socket, "socket", return_value=stream), mock.patch.object(check.socket, "if_nametoindex", return_value=20):
                result = check.probe_target("10.99.254.2", port, "utun4", "100.70.80.90", time.monotonic() + 20)
            self.assertEqual(result["tcp"], "connected")
            stream.sendall.assert_not_called()
            stream.recv.assert_not_called()

    def test_tls_failure_has_no_insecure_retry_and_headers_have_size_limit(self):
        stream = self.fake_socket()
        context = mock.Mock()
        context.wrap_socket.side_effect = ssl.SSLCertVerificationError("SECRET_CERT")
        with mock.patch.object(check.socket, "socket", return_value=stream), mock.patch.object(check.socket, "if_nametoindex", return_value=20), mock.patch.object(check.ssl, "create_default_context", return_value=context):
            result = check.probe_target("10.99.254.2", 443, "utun4", "100.70.80.90", time.monotonic() + 20)
        self.assertEqual(result["tls"], "certificate-not-verified-no-insecure-retry")
        context.wrap_socket.assert_called_once_with(stream, server_hostname="10.99.254.2")
        stream.sendall.assert_not_called()
        self.assertNotIn("SECRET", json.dumps(result))
        stream = self.fake_socket()
        stream.recv.side_effect = None
        stream.recv.return_value = b"x" * 2048
        with mock.patch.object(check.socket, "socket", return_value=stream), mock.patch.object(check.socket, "if_nametoindex", return_value=20):
            result = check.probe_target("10.99.254.2", 80, "utun4", "100.70.80.90", time.monotonic() + 20)
        self.assertEqual(stream.recv.call_count, check.MAX_HTTP_HEADER // 2048)
        self.assertEqual(result["http"]["status"], "incomplete-or-oversized-header")

    def test_reports_private_html_escaped_and_tls_visible(self):
        report = check.perform_check(manifest(), FakeSystem(), probe=passing_probe)
        report["targets"][0]["name"] = "<script>alert('not executed')</script>"
        report["targets"][0]["ports"].append({"port": 443, "tcp": "connected", "tls": "certificate-not-verified-no-insecure-retry", "http": {"status": "not-requested"}})
        with tempfile.TemporaryDirectory() as directory:
            output = check.write_report(report, directory)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
            for filename in ("remote-check.json", "remote-check.html"):
                self.assertEqual(stat.S_IMODE((output / filename).stat().st_mode), 0o600)
                self.assertNotIn("SECRET", (output / filename).read_text())
            html_text = (output / "remote-check.html").read_text()
            self.assertIn("&lt;script&gt;", html_text)
            self.assertNotIn("<script>", html_text)
            self.assertIn("certificate-not-verified-no-insecure-retry", html_text)
            self.assertIn("Content-Security-Policy", html_text)
            self.assertIn("confirmation pending", html_text)

    def test_local_command_time_and_output_bounds_and_sanitized_environment(self):
        with mock.patch.dict(os.environ, {"TS_AUTHKEY": "SECRET", "HTTPS_PROXY": "SECRET", "DYLD_INSERT_LIBRARIES": "SECRET"}):
            env = check.clean_env()
            self.assertNotIn("SECRET", json.dumps(env))
            self.assertEqual(env["TAILSCALE_BE_CLI"], "1")
        with self.assertRaises(check.CheckError):
            check.run_command([sys.executable, "-I", "-c", "print('x'*20000)"], limit=1024)
        with self.assertRaises(check.CheckError):
            check.run_command([sys.executable, "-I", "-c", "import time; time.sleep(2)"], timeout=0.05)
        with self.assertRaises(check.CheckError) as exc:
            check.run_command([sys.executable, "-I", "-c", "import sys; print('SECRET', file=sys.stderr); sys.exit(2)"])
        self.assertNotIn("SECRET", str(exc.exception))

    def test_explicit_app_open_has_no_manifest_probe_or_install(self):
        with mock.patch.object(check, "MacSystem") as system, mock.patch.object(check, "read_manifest") as read, mock.patch.object(check, "perform_check") as perform, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(check.main(["--open-tailscale"]), 0)
        system.return_value.open_app.assert_called_once_with()
        read.assert_not_called()
        perform.assert_not_called()

    def test_browser_open_refuses_redirects_missing_web_tls_and_error_pages(self):
        target = manifest()["targets"][1]
        good = {"ports": [{"port": 80, "tcp": "connected", "http": {"status": "response-received", "statusCode": 200}}]}
        check.require_usable_web_response(target, good)
        for response in ({"status": "not-requested"}, {"status": "response-received", "statusCode": 500},
                         {"status": "response-received", "statusCode": 302, "redirect": "different-origin"},
                         {"status": "response-received", "statusCode": 302, "redirect": "relative"}):
            result = copy.deepcopy(good)
            result["ports"][0]["http"] = response
            with self.subTest(response=response), self.assertRaises(check.CheckError):
                check.require_usable_web_response(target, result)
        target = copy.deepcopy(target)
        target["tcpPorts"] = [443]
        bad_tls = {"ports": [{"port": 443, "tcp": "connected", "tls": "certificate-not-verified-no-insecure-retry", "http": {"status": "not-requested"}}]}
        with self.assertRaises(check.CheckError):
            check.require_usable_web_response(target, bad_tls)

    def test_explicit_browser_action_does_not_open_a_redirecting_target(self):
        value = manifest()
        report = check.perform_check(value, FakeSystem(), probe=passing_probe)
        report["targets"][1]["ports"][0]["http"] = {"status": "response-received", "statusCode": 302, "redirect": "different-origin"}
        system = FakeSystem()
        system.open_target = mock.Mock()
        with mock.patch.object(check, "MacSystem", return_value=system), mock.patch.object(check, "read_manifest", return_value=value), mock.patch.object(check, "perform_check", return_value=report), mock.patch.object(check, "write_report", return_value=Path("/synthetic/private-report")), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(check.main(["/synthetic/owner-targets.json", "--open-target", "bridge-a"]), 2)
        system.open_target.assert_not_called()

    def test_launcher_shell_syntax(self):
        subprocess.run(["/bin/bash", "-n", str(Path(__file__).with_name("Check_PasoFi_Remote.command"))], check=True)

    @unittest.skipUnless(platform.system() == "Darwin", "Native macOS socket API check")
    def test_native_macos_interface_binding_without_any_connection(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as stream:
            index = socket.if_nametoindex("lo0")
            stream.setsockopt(socket.IPPROTO_IP, check.IP_BOUND_IF, index)
            stream.bind(("127.0.0.1", 0))
            self.assertEqual(stream.getsockopt(socket.IPPROTO_IP, check.IP_BOUND_IF), index)
            # Deliberately never call connect or listen, including on localhost.


if __name__ == "__main__":
    unittest.main()
