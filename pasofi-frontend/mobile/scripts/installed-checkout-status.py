"""Operate the installed qualification APK via Android's accessibility tree."""
import re
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = "com.onesa.pasofi"


def adb(*args):
    return subprocess.check_output(["adb", *args], text=True, timeout=20)


def locate(label):
    adb("shell", "uiautomator", "dump", "/sdcard/onesa-qualification.xml")
    tree = ET.fromstring(adb("shell", "cat", "/sdcard/onesa-qualification.xml").strip())
    for node in tree.iter("node"):
        if not any(label in (node.get(attr) or "") for attr in ("text", "content-desc")):
            continue
        values = [int(x) for x in re.findall(r"\d+", node.get("bounds", ""))]
        if len(values) == 4 and values[2] > values[0] and values[3] > values[1]:
            return (values[0] + values[2]) // 2, (values[1] + values[3]) // 2
    return None


def visible(label, allow_scroll=False):
    end = time.monotonic() + 55
    while time.monotonic() < end:
        point = locate(label)
        if point is not None:
            return point
        if allow_scroll:
            adb("shell", "input", "swipe", "480", "1180", "480", "440", "360")
        time.sleep(1)
    raise RuntimeError("The installed app never displayed " + label)


def tap(label, allow_scroll=False):
    x, y = visible(label, allow_scroll)
    adb("shell", "input", "tap", str(x), str(y))



if __name__ == "__main__":
    try:
        adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
        tap("My PasoFi")
        end = time.monotonic() + 65
        while time.monotonic() < end:
            if locate("Mobile account access is not enabled by this deployment yet"):
                print("Installed configured app reports mobile account access disabled before checkout. No payment was attempted.", flush=True)
                raise SystemExit(0)
            if locate("No account is active in this app"):
                break
            time.sleep(1)
        else:
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
