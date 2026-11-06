#!/usr/bin/env python3
"""Read-only, explicitly targeted macOS owner-management transport checks.

No SSH, credentials, private keys, VPN changes, discovery scan or deployment.
The report never qualifies authenticated device identity or a complete remote site.
"""

import argparse
import datetime as dt
import html
import ipaddress
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import selectors
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


MAX_MANIFEST = 256 * 1024
MAX_COMMAND = 2 * 1024 * 1024
MAX_HTTP_HEADER = 16 * 1024
CHECK_SECONDS = 120
PROBE_SECONDS = 4
IP_BOUND_IF = 25  # Public Darwin bsd/netinet/in.h socket option.
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(x) for x in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
TAILSCALE_NETWORK = ipaddress.ip_network("100.64.0.0/10")
ID_PATTERN = r"[a-z][a-z0-9-]{0,31}"
TOP_KEYS = {"schemaVersion", "kind", "status", "planId", "expectedTailscaleLogin",
            "expectedHubNodeId", "requiredRoutes", "targets"}
TARGET_KEYS = {"id", "name", "role", "gatewayId", "vendor", "address", "tcpPorts",
               "icmp", "expectedIdentity", "verifiedAt"}
BUNDLE_IDS = {"io.tailscale.ipn.macsys": "standalone", "io.tailscale.ipn.macos": "app-store"}


class CheckError(Exception):
    """Messages are fixed local descriptions, never remote stderr or response data."""


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def exact_keys(value, keys, label):
    if type(value) is not dict or set(value) != keys:
        raise CheckError(label + " has missing or unrecognized fields")


def match(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def private_address(value):
    try:
        address = ipaddress.IPv4Address(value)
        return isinstance(value, str) and str(address) == value and any(address in n for n in PRIVATE_NETWORKS)
    except (ValueError, TypeError):
        return False


def valid_login(value):
    if not isinstance(value, str) or len(value) > 160 or not re.fullmatch(r"[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+", value):
        return False
    domain = value.split("@")[1]
    if domain in ("github", "passkey"):
        return True
    return ("." in domain and not re.fullmatch(r"[\d.]+", domain)
            and all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in domain.split(".")))


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise CheckError("JSON contains duplicate fields")
            result[key] = value
        return result
    def constant(_value):
        raise CheckError("JSON contains a non-finite number")
    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise CheckError("JSON could not be read") from exc


def validate_manifest(value):
    exact_keys(value, TOP_KEYS, "Target manifest")
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or value["kind"] != "pasofi-owner-management" or value["status"] != "prepared-only"):
        raise CheckError("Unsupported target manifest kind, version or status")
    if not match(value["planId"], ID_PATTERN):
        raise CheckError("Invalid plan ID")
    if not valid_login(value["expectedTailscaleLogin"]):
        raise CheckError("An exact verified Tailscale login is required")
    if not match(value["expectedHubNodeId"], r"[A-Za-z0-9_-]{1,128}"):
        raise CheckError("An observed stable Tailscale hub node ID is required")
    targets = value["targets"]
    if type(targets) is not list or not 1 <= len(targets) <= 128:
        raise CheckError("The target list must contain 1 to 128 explicit devices")
    ids, addresses, gateways, identities = set(), set(), set(), set()
    for target in targets:
        exact_keys(target, TARGET_KEYS, "Target")
        if not match(target["id"], ID_PATTERN) or not match(target["gatewayId"], ID_PATTERN):
            raise CheckError("Invalid target or gateway ID")
        name = target["name"]
        try:
            valid_name = isinstance(name, str) and name.strip() and 1 <= len(name.encode("utf-8")) <= 80 and not re.search(r"[\x00-\x1f\x7f]", name)
        except UnicodeError:
            valid_name = False
        if not valid_name:
            raise CheckError("Target name must be bounded text without control characters")
        if target["role"] not in ("gateway", "downstream") or target["vendor"] not in ("mikrotik", "tenda", "mercusys", "other"):
            raise CheckError("Unsupported target role or vendor")
        if not private_address(target["address"]):
            raise CheckError("Targets require canonical private IPv4 addresses")
        ports = target["tcpPorts"]
        if (type(ports) is not list or not 1 <= len(ports) <= 4
                or any(type(p) is not int or p not in (22, 80, 443, 8291) for p in ports)
                or len(set(ports)) != len(ports)):
            raise CheckError("Only unique explicit management TCP ports are allowed")
        if type(target["icmp"]) is not bool:
            raise CheckError("The ICMP policy field must be boolean")
        identity = target["expectedIdentity"]
        exact_keys(identity, {"kind", "value"}, "Expected identity")
        if not ((identity["kind"] == "serial" and match(identity["value"], r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}"))
                or (identity["kind"] == "mac" and match(identity["value"], r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}"))):
            raise CheckError("An observed canonical serial or MAC identity is required")
        if identity["kind"] == "mac" and (identity["value"] == "00:00:00:00:00:00" or int(identity["value"][:2], 16) & 1):
            raise CheckError("A nonzero unicast physical MAC identity is required")
        identity_key = (identity["kind"], identity["value"].lower())
        if identity_key in identities:
            raise CheckError("Each target requires a distinct observed physical identity")
        identities.add(identity_key)
        if not match(target["verifiedAt"], r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z"):
            raise CheckError("Inventory observation time must be UTC ISO time")
        try:
            dt.datetime.fromisoformat(target["verifiedAt"].replace("Z", "+00:00"))
        except ValueError as exc:
            raise CheckError("Inventory observation time is not calendar-valid") from exc
        if target["id"] in ids or target["address"] in addresses:
            raise CheckError("Target IDs and management addresses must be unique")
        ids.add(target["id"])
        addresses.add(target["address"])
        if target["role"] == "gateway":
            if target["gatewayId"] != target["id"] or target["vendor"] != "mikrotik" or identity["kind"] != "serial":
                raise CheckError("Gateway targets require their own ID and MikroTik serial")
            gateways.add(target["id"])
    if any(t["gatewayId"] not in gateways for t in targets):
        raise CheckError("Every target must reference an explicit gateway target")
    if value["requiredRoutes"] != [t["address"] + "/32" for t in targets]:
        raise CheckError("Required routes must exactly match the ordered target /32 list")
    return value


def read_manifest(path):
    try:
        # Nonblocking open lets fstat reject a FIFO without waiting for a writer.
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise CheckError("Use an owner-owned private target file (permissions 600)")
            data = stream.read(MAX_MANIFEST + 1)
    except OSError as exc:
        raise CheckError("The private target file could not be opened") from exc
    if len(data) > MAX_MANIFEST:
        raise CheckError("Target file exceeds the size limit")
    return validate_manifest(strict_json(data))


def clean_env():
    result = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C", "LANG": "C", "TAILSCALE_BE_CLI": "1"}
    for key in ("HOME", "USER", "LOGNAME", "TMPDIR"):
        if key in os.environ:
            result[key] = os.environ[key]
    return result


def run_command(argv, timeout=8, limit=MAX_COMMAND):
    """Bound time and stdout; discard stderr instead of exposing auth links/tokens."""
    process = None
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=clean_env(), cwd="/")
        deadline, output = time.monotonic() + timeout, bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CheckError("A local read-only command timed out")
                for key, _event in selector.select(min(remaining, 0.25)):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(chunk)
                        if len(output) > limit:
                            raise CheckError("A local read-only response exceeded the size limit")
            remaining = deadline - time.monotonic()
            if remaining <= 0 or process.wait(timeout=remaining) != 0:
                raise CheckError("A local read-only command did not succeed")
        return bytes(output).decode("utf-8", errors="strict")
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise CheckError("A local read-only command was unavailable or failed") from exc
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
            if process.stdout is not None:
                process.stdout.close()


def parse_interfaces(text):
    interfaces, current = {}, None
    for line in text.splitlines():
        header = re.match(r"^([A-Za-z][A-Za-z0-9]*): flags=[0-9a-fA-F]+<([^>]*)>", line)
        if header:
            name, flags = header.groups()
            if name in interfaces:
                raise CheckError("Ambiguous local interface inventory")
            current = {"name": name, "active": "UP" in flags.split(",") and "RUNNING" in flags.split(","), "ipv4": []}
            interfaces[name] = current
        elif current is not None and line.strip().startswith("status:"):
            current["active"] = line.strip() == "status: active"
        elif current is not None and line.lstrip().startswith("inet "):
            entry = re.match(r"\s+inet (\S+)(?: --> \S+)? netmask (\S+)", line)
            if not entry:
                raise CheckError("Unsupported local IPv4 interface format")
            try:
                address, mask = entry.groups()
                if mask.startswith("0x"):
                    mask = str(ipaddress.IPv4Address(int(mask, 16)))
                network = ipaddress.IPv4Interface(address + "/" + mask)
            except ValueError as exc:
                raise CheckError("Invalid local interface address") from exc
            current["ipv4"].append({"address": str(network.ip), "network": str(network.network)})
    if not interfaces:
        raise CheckError("Local network interfaces could not be established")
    return interfaces


def parse_hardware(text):
    result, label = {}, None
    for line in text.splitlines():
        if line.startswith("Hardware Port: "):
            label = line[len("Hardware Port: "):].strip()
        elif line.startswith("Device: ") and label is not None:
            device = line[len("Device: "):].strip()
            if not match(device, r"[A-Za-z][A-Za-z0-9]*") or device in result:
                raise CheckError("Ambiguous physical network interface inventory")
            result[device] = "wifi" if label.lower() in ("wi-fi", "airport") else "wired-or-other"
            label = None
    if not result:
        raise CheckError("Physical Wi-Fi and Ethernet interfaces could not be identified")
    return result


def parse_route(text, address=None):
    fields = {}
    for line in text.splitlines():
        if ":" in line:
            key, value = line.strip().split(":", 1)
            if key in ("route to", "destination", "mask", "gateway", "interface", "flags"):
                if key in fields:
                    raise CheckError("Ambiguous macOS route response")
                fields[key] = value.strip()
    if not match(fields.get("interface"), r"[A-Za-z][A-Za-z0-9]*"):
        raise CheckError("The actual macOS route interface is unknown")
    if address is not None and fields.get("route to") != address:
        raise CheckError("The actual macOS route did not identify the requested target")
    flags = fields.get("flags", "").strip("<>").split(",")
    if "UP" not in flags or any(x in flags for x in ("REJECT", "BLACKHOLE")):
        raise CheckError("The actual macOS route is inactive or rejecting traffic")
    return {"interface": fields["interface"], "destination": fields.get("destination"), "gateway": fields.get("gateway")}


class MacSystem:
    def __init__(self):
        self.app = None
        self.variant = None
        self.deadline = None

    def read(self, argv, timeout=8, limit=MAX_COMMAND):
        if self.deadline is not None:
            try:
                timeout = min(timeout, remaining(self.deadline))
            except TimeoutError as exc:
                raise CheckError("Overall check time limit reached") from exc
        return run_command(argv, timeout=timeout, limit=limit)

    def find_app(self):
        if platform.system() != "Darwin":
            raise CheckError("Run this checker on the owner's Mac; other systems are unsupported")
        version = self.read(["/usr/bin/sw_vers", "-productVersion"], limit=256).strip()
        if not match(version, r"\d+\.\d+(?:\.\d+)?") or int(version.split(".")[0]) < 13:
            raise CheckError("This checker supports macOS 13 or newer")
        candidates = [p for p in (Path("/Applications/Tailscale.app"), Path.home() / "Applications/Tailscale.app") if p.exists()]
        if len(candidates) != 1:
            raise CheckError("Install exactly one official Tailscale Mac app, or resolve duplicate app copies")
        app = candidates[0]
        try:
            with (app / "Contents/Info.plist").open("rb") as stream:
                raw = stream.read(MAX_MANIFEST + 1)
            if len(raw) > MAX_MANIFEST:
                raise ValueError()
            bundle_id = plistlib.loads(raw).get("CFBundleIdentifier")
        except (OSError, ValueError, plistlib.InvalidFileException) as exc:
            raise CheckError("The Tailscale app identity could not be read") from exc
        if bundle_id not in BUNDLE_IDS:
            raise CheckError("The installed app is not a supported Tailscale Mac variant")
        requirement = 'anchor apple generic and certificate leaf[subject.OU] = "W5364U7YZB"'
        self.read(["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", requirement, str(app)], timeout=10)
        self.app, self.variant = app, BUNDLE_IDS[bundle_id]
        return version

    def observe(self):
        version = self.find_app()
        interfaces = parse_interfaces(self.read(["/sbin/ifconfig", "-a"]))
        hardware = parse_hardware(self.read(["/usr/sbin/networksetup", "-listallhardwareports"]))
        default = parse_route(self.read(["/sbin/route", "-n", "get", "default"]))
        status = strict_json(self.read([str(self.app / "Contents/MacOS/Tailscale"), "status", "--json"]))
        return {"macOS": version, "variant": self.variant, "interfaces": interfaces, "hardware": hardware,
                "defaultRoute": default, "tailscale": status}

    def route(self, address):
        return parse_route(self.read(["/sbin/route", "-n", "get", address], timeout=3, limit=8192), address)

    def open_app(self):
        self.find_app()
        self.read(["/usr/bin/open", "-a", str(self.app)])

    def open_target(self, target):
        port = 443 if 443 in target["tcpPorts"] else 80 if 80 in target["tcpPorts"] else None
        if port is None:
            raise CheckError("This target has no approved web port; open its address in native WinBox manually")
        scheme = "https" if port == 443 else "http"
        self.read(["/usr/bin/open", scheme + "://" + target["address"] + "/"])


def assess_vpn(manifest, snapshot):
    status = snapshot["tailscale"]
    if type(status) is not dict or status.get("BackendState") != "Running":
        raise CheckError("Tailscale is not running and authenticated")
    own = status.get("Self")
    users = status.get("User")
    if type(own) is not dict or type(users) is not dict or type(own.get("UserID")) is not int or own["UserID"] <= 0:
        raise CheckError("The current Tailscale owner identity is unknown")
    profile = users.get(str(own["UserID"]))
    if type(profile) is not dict or profile.get("LoginName") != manifest["expectedTailscaleLogin"]:
        raise CheckError("The current Tailscale login does not match the approved owner")
    if own.get("Online") is not True or own.get("Expired") is True:
        raise CheckError("The owner's Tailscale device is offline or expired")
    if status.get("ExitNodeStatus") is not None:
        raise CheckError("An exit node is active; the expected split-route state is ambiguous")
    peers = status.get("Peer")
    if type(peers) is not dict:
        raise CheckError("The expected Tailscale hub is unknown")
    matches = [p for p in peers.values() if type(p) is dict and p.get("ID") == manifest["expectedHubNodeId"]]
    if len(matches) != 1 or matches[0].get("Online") is not True or matches[0].get("Expired") is True:
        raise CheckError("The exact expected Tailscale hub is missing, ambiguous, offline or expired")
    hub = matches[0]
    primary = hub.get("PrimaryRoutes")
    if type(primary) is not list or any(not isinstance(p, str) for p in primary):
        raise CheckError("The hub's current primary routes are unavailable; route ownership is unverified")
    own_ips = own.get("TailscaleIPs")
    if type(own_ips) is not list or len(own_ips) > 8:
        raise CheckError("The current Tailscale source address is unknown")
    try:
        source_ips = [str(ipaddress.IPv4Address(p)) for p in own_ips if isinstance(p, str) and ":" not in p]
    except ValueError as exc:
        raise CheckError("The current Tailscale source address is invalid") from exc
    if not source_ips or any(ipaddress.IPv4Address(p) not in TAILSCALE_NETWORK for p in source_ips):
        raise CheckError("The current Tailscale IPv4 source address is unsupported")
    bindings = [(name, item["address"]) for name, interface in snapshot["interfaces"].items()
                if re.fullmatch(r"utun\d+", name) and interface["active"]
                for item in interface["ipv4"] if item["address"] in source_ips]
    if len(bindings) != 1:
        raise CheckError("The actual Tailscale tunnel interface and source address are ambiguous")
    interface, source = bindings[0]
    other_primary = set()
    for peer in peers.values():
        if type(peer) is dict and peer.get("ID") != manifest["expectedHubNodeId"]:
            values = peer.get("PrimaryRoutes", [])
            if type(values) is list:
                other_primary.update(p for p in values if isinstance(p, str))
    return {"login": manifest["expectedTailscaleLogin"], "hubNodeId": manifest["expectedHubNodeId"],
            "interface": interface, "sourceAddress": source, "primaryRoutes": primary, "otherPrimaryRoutes": sorted(other_primary)}


def assess_target(target, snapshot, vpn, route):
    address = ipaddress.IPv4Address(target["address"])
    for name, interface in snapshot["interfaces"].items():
        if name == vpn["interface"] or name == "lo0" or not interface["active"]:
            continue
        if any(address in ipaddress.IPv4Network(item["network"]) for item in interface["ipv4"]):
            raise CheckError("Target overlaps an active local or other-VPN network; resolve the address conflict")
    required = target["address"] + "/32"
    if required not in vpn["primaryRoutes"] or required in vpn["otherPrimaryRoutes"]:
        raise CheckError("The expected hub is not the unique current primary router for this target /32")
    if route["interface"] != vpn["interface"]:
        raise CheckError("The target's actual macOS route does not use the verified Tailscale interface")
    return {"interface": route["interface"], "hubNodeId": vpn["hubNodeId"], "primaryRoute": required,
            "sourceAddress": vpn["sourceAddress"], "status": "correlated"}


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError()
    return value


def http_summary(data, address, port):
    header = data.split(b"\r\n\r\n", 1)[0].decode("iso-8859-1")
    lines = header.split("\r\n")
    match_status = re.fullmatch(r"HTTP/1\.[01] ([1-5]\d\d)(?: [\x20-\x7e]*)?", lines[0])
    if not match_status:
        return {"status": "unrecognized-response"}
    code = int(match_status.group(1))
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers.setdefault(key.lower(), value.strip())
    result = {"status": "response-received", "statusCode": code,
              "authenticationChallenge": "www-authenticate" in headers,
              "deviceIdentityVerified": False}
    if 300 <= code < 400:
        kind = "missing-or-unparseable"
        try:
            destination = urlsplit(headers.get("location", ""))
            if headers.get("location"):
                scheme = "https" if port == 443 else "http"
                if not destination.scheme and not destination.netloc:
                    kind = "relative"
                elif (destination.scheme == scheme and destination.hostname == address
                      and (destination.port or (443 if scheme == "https" else 80)) == port
                      and destination.username is None and destination.password is None):
                    kind = "same-origin"
                else:
                    kind = "different-origin"
        except ValueError:
            pass
        result.update({"redirect": kind, "redirectFollowed": False})
    return result


def probe_target(address, port, interface, source, deadline):
    """One bound TCP connection; only web ports receive one credential-free GET /."""
    result = {"port": port, "tcp": "not-connected"}
    deadline = min(deadline, time.monotonic() + PROBE_SECONDS)
    stream = None
    try:
        stream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        stream.settimeout(remaining(deadline))
        stream.setsockopt(socket.IPPROTO_IP, IP_BOUND_IF, socket.if_nametoindex(interface))
        stream.bind((source, 0))
        stream.connect((address, port))
        result["tcp"] = "connected"
        if port not in (80, 443):
            return result
        if port == 443:
            stream.settimeout(remaining(deadline))
            stream = ssl.create_default_context().wrap_socket(stream, server_hostname=address)
            result["tls"] = "certificate-verified-for-target-ip"
        stream.settimeout(remaining(deadline))
        stream.sendall(("GET / HTTP/1.1\r\nHost: " + address + "\r\nUser-Agent: PasoFi-ReadOnly-Check/1\r\n"
                        "Accept: text/html\r\nConnection: close\r\n\r\n").encode("ascii"))
        data = bytearray()
        while b"\r\n\r\n" not in data and len(data) < MAX_HTTP_HEADER:
            stream.settimeout(remaining(deadline))
            chunk = stream.recv(min(2048, MAX_HTTP_HEADER - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        result["http"] = http_summary(bytes(data), address, port) if b"\r\n\r\n" in data else {"status": "incomplete-or-oversized-header"}
    except ssl.SSLCertVerificationError:
        result["tls"] = "certificate-not-verified-no-insecure-retry"
        result["http"] = {"status": "not-requested"}
    except (socket.timeout, TimeoutError):
        result["error"] = "timeout"
    except (OSError, ssl.SSLError):
        result["error"] = "connection-or-interface-binding-failed"
    finally:
        if stream is not None:
            stream.close()
    return result


def network_evidence(snapshot, different_wifi):
    active = [n for n, item in snapshot["interfaces"].items() if item["active"]]
    wifi = [n for n, kind in snapshot["hardware"].items() if kind == "wifi" and n in active]
    wired = [n for n, kind in snapshot["hardware"].items() if kind != "wifi" and n in active]
    return {"activeWifiInterfaces": wifi, "activeWiredOrOtherInterfaces": wired,
            "defaultRouteInterface": snapshot["defaultRoute"]["interface"],
            "wifiDefaultAndNoWiredInterfaceObserved": bool(wifi) and not wired and snapshot["defaultRoute"]["interface"] in wifi,
            "differentWifi": "operator-reported" if different_wifi else "not-confirmed",
            "offSiteIndependentlyVerified": False}


def perform_check(manifest, system, probe=probe_target, different_wifi=False):
    validate_manifest(manifest)
    deadline = time.monotonic() + CHECK_SECONDS
    system.deadline = deadline
    report = {"schemaVersion": 1, "kind": "pasofi-owner-mac-check", "planId": manifest["planId"],
              "startedAt": utc_now(), "status": "blocked", "issues": [], "targets": [],
              "qualification": {"qualified": False, "authenticatedDeviceIdentities": "pending",
                                "policyDenialTests": "pending", "reconnectTests": "pending",
                                "customerReadiness": "not-tested", "firmwareChanges": "not-performed"}}
    snapshot, vpn = None, None
    try:
        snapshot = system.observe()
        report["macOS"] = snapshot["macOS"]
        report["clientVariant"] = snapshot["variant"]
        report["network"] = network_evidence(snapshot, different_wifi)
        vpn = assess_vpn(manifest, snapshot)
        report["vpn"] = {key: vpn[key] for key in ("login", "hubNodeId", "interface", "sourceAddress")}
        report["vpn"]["hubOnlineMeans"] = "control-plane-presence-only"
    except CheckError as exc:
        report["issues"].append(str(exc))
    for target in manifest["targets"]:
        item = {key: target[key] for key in ("id", "name", "vendor", "address", "expectedIdentity", "verifiedAt")}
        item.update({"identity": "pending-authenticated-ui-check", "route": {"status": "not-checked"}, "ports": []})
        report["targets"].append(item)
        if vpn is None:
            item["blockedReason"] = "VPN or local-network preflight did not pass"
            continue
        try:
            remaining(deadline)
            item["route"] = assess_target(target, snapshot, vpn, system.route(target["address"]))
            for port in target["tcpPorts"]:
                remaining(deadline)
                # Recheck the actual route immediately before every bound probe.
                assess_target(target, snapshot, vpn, system.route(target["address"]))
                item["ports"].append(probe(target["address"], port, vpn["interface"], vpn["sourceAddress"], deadline))
            item["checkedAt"] = utc_now()
        except (CheckError, TimeoutError) as exc:
            item["blockedReason"] = str(exc) if isinstance(exc, CheckError) else "Overall check time limit reached"
            item["route"]["status"] = "blocked"
    if vpn is not None:
        try:
            remaining(deadline)
            final = system.observe()
            final_vpn = assess_vpn(manifest, final)
            if final_vpn != vpn or network_evidence(final, different_wifi) != report["network"] or final["interfaces"] != snapshot["interfaces"]:
                raise CheckError("VPN or local network changed during the check; rerun before using these results")
            report["vpn"]["stateStableDuringCheck"] = True
        except (CheckError, TimeoutError) as exc:
            report["issues"].append(str(exc) if isinstance(exc, CheckError) else "Check time limit prevented final state verification")
            report["vpn"]["stateStableDuringCheck"] = False
    all_tcp = not report["issues"] and all(
        not item.get("blockedReason") and len(item["ports"]) == len(target["tcpPorts"])
        and all(p["tcp"] == "connected" for p in item["ports"])
        for item, target in zip(report["targets"], manifest["targets"]))
    report["allListedTcpPortsReachable"] = all_tcp
    report["status"] = "transport-checked-identity-pending" if all_tcp else "incomplete"
    report["finishedAt"] = utc_now()
    return report


def render_html(report):
    esc = lambda value: html.escape(str(value), quote=True)
    rows = []
    for target in report["targets"]:
        port_lines = []
        for port in target["ports"]:
            detail = str(port["port"]) + ": TCP " + port["tcp"]
            if "error" in port:
                detail += "; " + port["error"]
            if "tls" in port:
                detail += "; TLS " + port["tls"]
            if "http" in port:
                response = port["http"]
                detail += "; HTTP " + str(response.get("statusCode", response["status"]))
                if "redirect" in response:
                    detail += "; " + response["redirect"] + " redirect not followed"
            port_lines.append(detail)
        ports = "\n".join(port_lines) or "Not tested"
        reason = target.get("blockedReason", target["route"]["status"])
        identity = target["expectedIdentity"]["kind"] + " " + target["expectedIdentity"]["value"]
        rows.append("<tr>" + "".join("<td>" + esc(x) + "</td>" for x in
                    (target["name"], target["address"], ports, reason, identity + " — confirmation pending")) + "</tr>")
    issues = "".join("<li>" + esc(x) + "</li>" for x in report["issues"])
    network = report.get("network", {})
    return ("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">"
            "<title>PasoFi remote-access check</title><style>body{font:16px system-ui;margin:32px;max-width:1150px;color:#16313b;background:#f6fafb}"
            "h1{color:#095e69}table{border-collapse:collapse;width:100%;background:white}th,td{padding:12px;text-align:left;border-bottom:1px solid #d9e5e8;white-space:pre-line}"
            ".notice{padding:16px;background:#fff0ce;border-radius:10px}code{overflow-wrap:anywhere}</style>"
            "<h1>PasoFi remote-access check</h1><p>" + esc(report["finishedAt"]) + " · Plan " + esc(report["planId"]) + "</p>"
            "<p class=\"notice\"><strong>" + esc(report["status"]) + "</strong><br>These are transport observations. Sign in to each device's normal management screen and confirm its serial or MAC before changing it. Device login, policy-denial and reconnect tests remain pending.</p>"
            "<h2>Connection context</h2><p>Different Wi-Fi: " + esc(network.get("differentWifi", "unknown"))
            + ". Wi-Fi default with no wired interface observed: " + esc(network.get("wifiDefaultAndNoWiredInterfaceObserved", "unknown"))
            + ". An off-site location is not independently established by these facts.</p><ul>" + issues + "</ul>"
            "<h2>Explicit targets</h2><table><thead><tr><th>Device</th><th>Management IP</th><th>TCP / web checks</th><th>Route / issue</th><th>Expected identity</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table><p>The companion JSON records HTTP/TLS results. Redirects are never followed; login pages do not establish device identity. No passwords, response bodies or raw Tailscale status were saved.</p>"
            "<p>Use native WinBox by IP for approved port 8291, or the device's WebFig, Tenda or Mercusys web interface. Keep the VPN connected and recheck after changing networks. No firmware or configuration changes were made.</p></html>")


def write_report(report, parent):
    parent = Path(parent)
    if not parent.is_dir() or parent.is_symlink():
        raise CheckError("Report output must be an existing local directory, not a symbolic link")
    directory = Path(tempfile.mkdtemp(prefix="PasoFi_Remote_Check_", dir=str(parent)))
    os.chmod(directory, 0o700)
    documents = {"remote-check.json": json.dumps(report, indent=2, ensure_ascii=True) + "\n",
                 "remote-check.html": render_html(report)}
    for name, data in documents.items():
        fd = os.open(str(directory / name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    return directory


def require_usable_web_response(target, result):
    """Opening a browser is explicit and never used to bypass a failed web check."""
    port = 443 if 443 in target["tcpPorts"] else 80 if 80 in target["tcpPorts"] else None
    if port is None:
        raise CheckError("This target has no approved web port; use its IP in native WinBox manually")
    matches = [item for item in result["ports"] if item["port"] == port]
    if len(matches) != 1:
        raise CheckError("The selected web port has no current usable response; its UI was not opened")
    response = matches[0].get("http", {})
    code = response.get("statusCode")
    if "redirect" in response:
        raise CheckError("The web response redirects; review the destination manually before opening the device UI")
    if (matches[0]["tcp"] != "connected" or response.get("status") != "response-received"
            or type(code) is not int or not (200 <= code <= 299 or code in (401, 403))
            or (port == 443 and matches[0].get("tls") != "certificate-verified-for-target-ip")):
        raise CheckError("The selected web port has no current usable response; its UI was not opened")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only Mac checks for the explicit PasoFi owner-management target manifest.")
    parser.add_argument("manifest", nargs="?", type=Path, default=Path(__file__).with_name("owner-targets.json"))
    parser.add_argument("--output", type=Path, help="Existing directory for a new private report folder (default: beside manifest)")
    parser.add_argument("--different-wifi", action="store_true", help="Record your assertion that this Wi-Fi is outside the PasoFi site; this is not independent proof")
    parser.add_argument("--open-tailscale", action="store_true", help="Only open the installed official Tailscale app; no login, installation or probes")
    parser.add_argument("--open-target", metavar="ID", help="After checks, explicitly open one approved target's normal web UI")
    args = parser.parse_args(argv)
    try:
        if args.open_tailscale:
            if args.open_target:
                raise CheckError("Choose either opening Tailscale or checking/opening a target")
            MacSystem().open_app()
            print("Opened Tailscale. Complete its normal owner login and macOS VPN permission if needed.")
            return 0
        manifest = read_manifest(args.manifest)
        if args.open_target and args.open_target not in [t["id"] for t in manifest["targets"]]:
            raise CheckError("The requested target is not explicitly listed")
        system = MacSystem()
        report = perform_check(manifest, system, different_wifi=args.different_wifi)
        directory = write_report(report, args.output or args.manifest.absolute().parent)
        print("PasoFi: " + report["status"] + ". Device identities and complete remote qualification remain pending.")
        print("Private report: " + str(directory / "remote-check.html"))
        if args.open_target:
            target = next(t for t in manifest["targets"] if t["id"] == args.open_target)
            result = next(t for t in report["targets"] if t["id"] == args.open_target)
            if report["issues"] or result.get("blockedReason") or not result["ports"] or not all(p["tcp"] == "connected" for p in result["ports"]):
                raise CheckError("The requested target did not pass the current transport checks; its UI was not opened")
            require_usable_web_response(target, result)
            fresh = system.observe()
            assess_target(target, fresh, assess_vpn(manifest, fresh), system.route(target["address"]))
            system.open_target(target)
        return 0 if report["allListedTcpPortsReachable"] else 3
    except (CheckError, OSError) as exc:
        message = str(exc) if isinstance(exc, CheckError) else "A local file operation failed"
        print("PasoFi check stopped: " + message, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
