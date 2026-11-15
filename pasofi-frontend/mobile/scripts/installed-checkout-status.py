"""Operate the installed qualification APK via Android's accessibility tree."""
import re
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = "com.onesa.pasofi"


def adb(*args):
    return subprocess.check_output(["adb", *args], text=True, timeout=20)


def screen():
    try:
        adb("shell", "uiautomator", "dump", "/sdcard/onesa-qualification.xml")
        tree = ET.fromstring(adb("shell", "cat", "/sdcard/onesa-qualification.xml").strip())
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ET.ParseError):
        # Accessibility can be temporarily unavailable while the stock system
        # and embedded WebView finish their initial layout.
        return []
    return list(tree.iter("node"))


def locate(label, exact=False, nodes=None):
    for node in screen() if nodes is None else nodes:
        labels = [node.get(attr) or "" for attr in ("text", "content-desc")]
        if not any((label == value if exact else label in value) for value in labels):
            continue
        values = [int(x) for x in re.findall(r"\d+", node.get("bounds", ""))]
        if len(values) == 4 and values[2] > values[0] and values[3] > values[1]:
            return (values[0] + values[2]) // 2, (values[1] + values[3]) // 2
    return None


def visible(label, allow_scroll=False, exact=False):
    end = time.monotonic() + 55
    while time.monotonic() < end:
        point = locate(label, exact=exact)
        if point is not None:
            return point
        if allow_scroll:
            adb("shell", "input", "swipe", "480", "1180", "480", "440", "360")
        time.sleep(1)
    raise RuntimeError("The installed app never displayed " + label)


def tap(label, allow_scroll=False, exact=False):
    x, y = visible(label, allow_scroll, exact)
    adb("shell", "input", "tap", str(x), str(y))


def account_return_diagnostics():
    try:
        activity = adb("shell", "dumpsys", "activity", "activities")
        relevant = [line.strip() for line in activity.splitlines()
                    if PACKAGE in line and any(word in line for word in ("Resumed", "resumed", "topResumed", "mResumed"))]
        print("PasoFi activity state: " + (" | ".join(relevant[-8:]) if relevant else "not reported as resumed"), flush=True)
    except Exception as error:
        print("Could not inspect activity state: " + type(error).__name__, flush=True)
    try:
        logs = adb("logcat", "-d", "-t", "250", "AndroidRuntime:E", "*:S")
        if logs.strip():
            print("Android runtime errors:\\n" + logs[-8000:], flush=True)
    except Exception as error:
        print("Could not inspect Android runtime errors: " + type(error).__name__, flush=True)


def account_return_state():
    # A cold-start custom-scheme intent can arrive before the WebView has an
    # accessibility root. Wait for the exact activity and its rendered UI,
    # rather than treating a transient null UIAutomator root as a product bug.
    end = time.monotonic() + 60
    while time.monotonic() < end:
        try:
            activity = adb("shell", "dumpsys", "activity", "activities")
            resumed = any(PACKAGE in line and ("mResumedActivity" in line or "topResumedActivity" in line)
                          for line in activity.splitlines())
        except Exception:
            resumed = False
        nodes = screen() if resumed else []
        if locate("Accept an account handoff", exact=True, nodes=nodes):
            print("Installed app opened the account handoff form from the OS return intent.", flush=True)
            return
        for gate in (
            "Mobile account access is not enabled by this deployment yet",
            "The configured PasoFi service did not respond in time",
            "The configured PasoFi service could not be reached",
        ):
            if locate(gate, nodes=nodes):
                print("Installed app opened the account surface and preserved the fail-closed service gate: " + gate, flush=True)
                return
        time.sleep(1)
    account_return_diagnostics()
    raise RuntimeError("The installed PasoFi activity did not expose the account handoff form or a recognized fail-closed service gate after cold-start; see activity and AndroidRuntime diagnostics")



if __name__ == "__main__":
    try:
        # A fresh process launched from the fixed browser return must enter the
        # account surface. Production can still withhold private account access.
        adb("shell", "am", "force-stop", PACKAGE)
        adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity",
            "-a", "android.intent.action.VIEW", "-c", "android.intent.category.BROWSABLE",
            "-d", "com.onesa.pasofi://account/handoff")
        account_return_state()
        tap("Offline preview")
        visible("My PasoFi", exact=True)
        print("The system return opened the installed account surface; its Offline preview control returned home.", flush=True)
        adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
        tap("My PasoFi", exact=True)
        print("Entered My PasoFi from the installed application", flush=True)
        end = time.monotonic() + 65
        last_labels = []
        while time.monotonic() < end:
            nodes = screen()
            labels = [node.get(key) for node in nodes for key in ("text", "content-desc") if node.get(key)]
            if labels:
                last_labels = list(dict.fromkeys(labels))
            if locate("Mobile account access is not enabled by this deployment yet", nodes=nodes):
                print("Installed configured app reports mobile account access disabled before checkout. No payment was attempted.", flush=True)
                raise SystemExit(0)
            if locate("Account access is paused for this app", nodes=nodes):
                print("Installed configured app reports account access paused before checkout. No payment was attempted.", flush=True)
                raise SystemExit(0)
            if locate("No account is active in this app", nodes=nodes):
                break
            time.sleep(1)
        else:
            # This disposable fresh install has no test identity, account or payment inputs.
            print("Observed public first-run accessibility labels:", last_labels[:36], flush=True)
            raise RuntimeError("The installed app did not show a recognized hosted access state")
        print("Installed app reached the configured customer service as a guest", flush=True)
        tap("Bundles")
        end = time.monotonic() + 55
        while time.monotonic() < end:
            if locate("Online checkout is not enabled here"):
                print("Installed app displayed the live disabled-checkout state; no payment was attempted", flush=True)
                break
            if locate("Payment method") or locate("Purchase site"):
                print("Installed app displayed the configured checkout choices; no payment was attempted", flush=True)
                break
            adb("shell", "input", "swipe", "480", "1180", "480", "440", "360")
        else:
            raise RuntimeError("Configured checkout state did not appear")
    finally:
        adb("shell", "rm", "-f", "/sdcard/onesa-qualification.xml")
