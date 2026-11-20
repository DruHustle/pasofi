"""Inspect, sign and independently verify the PasoFi Google Play upload bundle."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from xml.etree import ElementTree
import zipfile


def run(*args, data=None):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, check=True).stdout


def inspect(bundle, unsigned):
    tool = os.environ["BUNDLETOOL_JAR"]
    run("java", "-jar", tool, "validate", f"--bundle={bundle}")
    manifest = ElementTree.fromstring(run("java", "-jar", tool, "dump", "manifest",
                                         f"--bundle={bundle}", "--module=base"))
    namespace = "{http://schemas.android.com/apk/res/android}"
    package = manifest.get("package")
    application = manifest.find("application")
    sdk = manifest.find("uses-sdk")
    version = manifest.get(namespace + "versionName")
    build = manifest.get(namespace + "versionCode", "")
    if package != "com.onesa.pasofi" or not version or not build.isdecimal() or int(build) < 1:
        raise ValueError("Unexpected PasoFi package or missing release version")
    if sdk is None or int(sdk.get(namespace + "targetSdkVersion", "0")) < 36:
        raise ValueError("Unexpected release target SDK")
    if application is None or application.get(namespace + "debuggable") == "true":
        raise ValueError("Expected a release application")
    for activity in application.findall("activity"):
        if activity.get(namespace + "name") not in (".MainActivity", package + ".MainActivity"):
            continue
        for intent in activity.findall("intent-filter"):
            actions = {a.get(namespace + "name") for a in intent.findall("action")}
            categories = {c.get(namespace + "name") for c in intent.findall("category")}
            if "android.intent.action.MAIN" in actions and "android.intent.category.LAUNCHER" in categories:
                break
        else:
            continue
        break
    else:
        raise ValueError("PasoFi launcher is missing")
    with zipfile.ZipFile(bundle) as archive:
        names = archive.namelist()
        if unsigned and any(re.fullmatch(r"META-INF/(?:[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)", n, re.I) for n in names):
            raise ValueError("Signing requires an unsigned release bundle")
        config = json.loads(archive.read("base/assets/capacitor.config.json"))
        if config["appId"] != package or config["plugins"]["PasoFiCustomerApi"]["origin"] != "https://pasofi.mobile.onesa.eu":
            raise ValueError("Embedded customer API configuration differs from production")
        if not archive.read("base/assets/public/index.html") or not any(
            n.startswith("base/assets/public/assets/") and n.endswith(".js") for n in names
        ):
            raise ValueError("Missing bundled PasoFi web assets")
    print(f"{package} {version} build {build}, target SDK {sdk.get(namespace + 'targetSdkVersion')}")


def verify_signature(bundle, work):
    expected = os.environ["ANDROID_PLAY_UPLOAD_CERT_SHA256"].replace(":", "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Expected the SHA-256 fingerprint of the Play Console upload certificate")
    certs = run("keytool", "-J-Duser.language=en", "-J-Duser.country=US", "-printcert", "-rfc", "-jarfile", bundle)
    if len(re.findall(rb"^Signer #[0-9]+:", certs, re.M)) != 1:
        raise ValueError("Expected one upload signer")
    leaf = run("openssl", "x509", "-outform", "DER", data=certs)
    if hashlib.sha256(leaf).hexdigest() != expected:
        raise ValueError("Bundle signer differs from the registered Play upload certificate")
    subject = run("openssl", "x509", "-inform", "DER", "-noout", "-subject", "-nameopt", "RFC2253", data=leaf)
    if re.search(rb"(?:subject=|,)CN=Android Debug(?:,|$)", subject.strip(), re.I):
        raise ValueError("Refusing the Android debug certificate")
    # Trust precisely the independently pinned public certificate. Strict verification
    # then also rejects unsigned payload entries and modified content.
    trust = work / "verification.p12"
    run("keytool", "-importcert", "-noprompt", "-keystore", trust, "-storepass", "public-certs",
        "-alias", "upload", data=leaf)
    run("jarsigner", "-verify", "-strict", "-keystore", trust, "-storepass", "public-certs", bundle, "upload")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("inspect-unsigned", "sign", "verify"):
        sub = commands.add_parser(name)
        sub.add_argument("input", type=Path)
        if name == "sign":
            sub.add_argument("output", type=Path)
    args = parser.parse_args()
    inspect(args.input, unsigned=args.command != "verify")
    checked = args.input
    if args.command != "inspect-unsigned":
        output = getattr(args, "output", None)
        with tempfile.TemporaryDirectory(dir=output.parent if output else None) as tmp:
            work = Path(tmp)
            if output:
                if output.exists():
                    raise ValueError("Choose a new output filename")
                signed = work / "upload.aab"
                run("jarsigner", "-keystore", os.environ["ANDROID_PLAY_UPLOAD_KEYSTORE"],
                    "-storepass:env", "ANDROID_PLAY_UPLOAD_STORE_PASSWORD",
                    "-keypass:env", "ANDROID_PLAY_UPLOAD_KEY_PASSWORD", "-signedjar", signed,
                    args.input, os.environ["ANDROID_PLAY_UPLOAD_ALIAS"])
                inspect(signed, unsigned=False)
                verify_signature(signed, work)
                os.link(signed, output)
                checked = output
            else:
                verify_signature(args.input, work)
    with checked.open("rb") as stream:
        print(hashlib.file_digest(stream, "sha256").hexdigest(), checked)


if __name__ == "__main__":
    main()
