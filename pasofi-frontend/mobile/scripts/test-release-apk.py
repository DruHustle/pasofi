"""Exercise the release helper against throwaway manifests and signing keys."""
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import unittest
import zipfile


class ReleaseApkTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.script = Path(__file__).with_name("sign-release-apk.sh")
        self.sdk = Path(os.environ["ANDROID_HOME"])
        self.tools = Path(os.environ.get("ANDROID_BUILD_TOOLS", self.sdk / "build-tools/36.0.0"))
        password = secrets.token_urlsafe(32)
        self.env = dict(os.environ, ANDROID_RELEASE_KEYSTORE=str(self.folder / "keys.p12"),
                        ANDROID_RELEASE_STORE_PASSWORD=password, ANDROID_RELEASE_KEY_PASSWORD=password)
        for alias, name in [("qa", "Temporary QA"), ("debug", "Android Debug")]:
            self.run_tool("keytool", "-genkeypair", "-alias", alias, "-keystore", self.env["ANDROID_RELEASE_KEYSTORE"],
                          "-storepass:env", "ANDROID_RELEASE_STORE_PASSWORD", "-keypass:env", "ANDROID_RELEASE_KEY_PASSWORD",
                          "-dname", f"CN={name}", "-keyalg", "RSA", "-keysize", "2048", "-validity", "1")
        self.select_key("qa")

    def run_tool(self, *command, success=True):
        run = subprocess.run(command, env=self.env, capture_output=True)
        if success:
            self.assertEqual(run.returncode, 0, run.stderr.decode())
        else:
            self.assertNotEqual(run.returncode, 0)
        return run.stdout

    def select_key(self, alias):
        cert = self.run_tool("keytool", "-exportcert", "-alias", alias, "-keystore", self.env["ANDROID_RELEASE_KEYSTORE"],
                             "-storepass:env", "ANDROID_RELEASE_STORE_PASSWORD")
        self.env["ANDROID_RELEASE_ALIAS"] = alias
        self.env["ANDROID_RELEASE_CERT_SHA256"] = hashlib.sha256(cert).hexdigest()

    def unsigned(self, filename, package="com.onesa.pasofi", debug=False):
        manifest = self.folder / "AndroidManifest.xml"
        manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{package}"
            android:versionCode="1" android:versionName="1.0"><uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/>
            <application android:label="Temporary QA" android:debuggable="{str(debug).lower()}">
            <activity android:name=".MainActivity" android:exported="true"><intent-filter>
            <action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter></activity></application></manifest>''')
        output = self.folder / filename
        self.run_tool(self.tools / "aapt2", "link", "-o", output, "-I", self.sdk / "platforms/android-36/android.jar",
                      "--manifest", manifest)
        return output

    def test_signing_and_verification(self):
        unsigned = self.unsigned("unsigned.apk")
        signed = self.folder / "signed.apk"
        rejected = self.folder / "rejected.apk"
        self.run_tool(self.script, "sign", unsigned, signed)
        self.run_tool(self.script, "verify", signed)
        self.run_tool(self.script, "sign", unsigned, signed, success=False)
        self.run_tool(self.script, "sign", signed, rejected, success=False)
        self.run_tool(self.script, "sign", self.unsigned("wrong.apk", package="example.other"), rejected, success=False)
        self.run_tool(self.script, "sign", self.unsigned("debug.apk", debug=True), rejected, success=False)
        self.env["ANDROID_RELEASE_CERT_SHA256"] = "0" * 64
        self.run_tool(self.script, "verify", signed, success=False)
        self.select_key("qa")
        with zipfile.ZipFile(signed, "a") as archive:
            archive.writestr("tampered.txt", "altered")
        self.run_tool(self.script, "verify", signed, success=False)
        self.select_key("debug")
        self.run_tool(self.script, "sign", unsigned, rejected, success=False)
        self.assertFalse(rejected.exists())


if __name__ == "__main__":
    unittest.main()
