import json
import os
import re
import subprocess
import time
from pathlib import Path
from xml.etree import ElementTree

package = "com.onesa.pasofi"
activity = package + "/.MainActivity"
root = Path(os.environ["RUNNER_TEMP"]) / "pasofi-upgrade-qa"
evidence = root / "evidence"
evidence.mkdir(exist_ok=True)
results = {"package": package, "scope": "API-unconfigured sandbox previews, disposable Android emulator",
           "previous_artifact": 13946805604, "current_artifact": 13953498139}
def adb(*args, check=True):
    return subprocess.run(["adb", *args], check=check, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, timeout=30)
def record(key, value):
    results[key] = value
    print("PASOFI", key, value, flush=True)
    (evidence / "installer.json").write_text(json.dumps(results, indent=2) + "\n")
def launch():
    adb("shell", "am", "start", "-W", "-n", activity)
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        state = adb("shell", "dumpsys", "activity", "activities").stdout
        if re.search(r"topResumedActivity=.*com[.]onesa[.]pasofi/.*MainActivity", state):
            return
        time.sleep(.5)
    raise AssertionError("MainActivity did not reach foreground")
def frame(name):
    with (evidence / name).open("wb") as f:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=f, timeout=15, check=True)
def locate(label, tap=False):
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        adb("shell", "uiautomator", "dump", "/sdcard/pasofi-preview-ui.xml", check=False)
        out = adb("shell", "cat", "/sdcard/pasofi-preview-ui.xml", check=False)
        try:
            hierarchy = ElementTree.fromstring(out.stdout)
        except ElementTree.ParseError:
            time.sleep(1)
            continue
        for node in hierarchy.iter("node"):
            attrs = node.attrib
            names = [attrs.get("text", ""), attrs.get("content-desc", "")]
            if not any(label.casefold() == text.strip().casefold() for text in names):
                continue
            if tap:
                coords = list(map(int, re.findall(r"-?\d+", attrs.get("bounds", ""))))
                if len(coords) != 4 or coords[2] <= coords[0] or coords[3] <= coords[1]:
                    continue
                adb("shell", "input", "tap", str((coords[0]+coords[2])//2), str((coords[1]+coords[3])//2))
            return
        time.sleep(1)
    frame("missing-landmark.png")
    raise AssertionError("Missing preview landmark: " + label)
assert adb("shell", "getprop", "ro.kernel.qemu").stdout.strip() == "1"
assert adb("shell", "getprop", "ro.build.version.sdk").stdout.strip() == "36"
record("emulator", "Android API 36 x86_64")
assert not adb("shell", "pm", "path", package, check=False).stdout.strip().startswith("package:")
assert adb("install", str(root / "previous.apk")).stdout.strip().endswith("Success")
launch()
record("original_clean_install_and_launch", True)
frame("previous-home.png")
adb("shell", "run-as", package, "mkdir", "-p", "files")
adb("shell", "run-as", package, "touch", "files/qualification-marker")
attempt = adb("install", "-r", str(root / "current.apk"), check=False)
assert attempt.returncode != 0 and "INSTALL_FAILED_UPDATE_INCOMPATIBLE" in attempt.stdout, "Expected Android's incompatible-signer result"
record("upgrade_installer_result", "INSTALL_FAILED_UPDATE_INCOMPATIBLE")
adb("shell", "run-as", package, "test", "-f", "files/qualification-marker")
launch()
record("prior_install_and_synthetic_marker_after_rejection", True)
assert adb("uninstall", package).stdout.strip().endswith("Success")
assert adb("install", str(root / "current.apk")).stdout.strip().endswith("Success")
launch()
record("current_clean_install_and_launch", True)
locate("Offline preview")
frame("current-home.png")
locate("Bundles", tap=True)
locate("Find your fit.")
frame("current-bundles.png")
record("customer_preview_home_to_bundles", True)
