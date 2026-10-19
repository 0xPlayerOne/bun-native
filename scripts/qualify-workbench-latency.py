"""Trusted browser input and actual xterm callbacks; not physical input-to-photon latency."""

import argparse
import hashlib
import importlib.util
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "frontend_driver", ROOT / "benchmarks/adapters/frontend/driver.py"
)
frontend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frontend)


def validate_trial(value, inputs, streams, expected_bytes):
    events, writes = value["input"], value["writes"]
    if value["trusted"] != inputs or len(events) != inputs:
        raise ValueError("Incomplete trusted input events")
    if not writes or sum(w["bytes"] for w in writes) != streams * expected_bytes:
        raise ValueError("Incomplete terminal callback bytes")
    for event in events:
        if set(event) != {"handlerToFrame", "eventToFrame"} or any(
            type(v) not in (float, int) or not 0 <= v < 10000 for v in event.values()
        ):
            raise ValueError("Invalid input latency")
    for w in writes:
        if not isinstance(w["bytes"], int) or w["bytes"] < 1 or not 0 <= w["callbackMs"] < 10000:
            raise ValueError("Invalid stream callback latency")
    return value


def wait_value(read, expected, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if read() == expected:
            return
        time.sleep(0.005)
    raise ValueError("Browser observation deadline")


def run(args):
    from playwright.sync_api import sync_playwright

    trials = []
    report = {
        "schema": 1,
        "profile": "shared-workbench-chromium-playwright-trusted-input",
        "runClass": "local-smoke",
        "passed": False,
        "trials": trials,
        "plan": {"warmups": 1, "repetitions": 3, "inputEvents": 120, "streams": 32},
        "limitations": [
            "CDP trusted input, not human device or physical presentation latency",
            "xterm parser callbacks, not terminal/PTY transport or per-byte network latency",
            "Headless Chrome for Testing; not an Electron/CEF/system-webview comparison",
            "Per-event samples are correlated within each independent browser context; retain trial boundaries",
        ],
    }
    process = None
    try:
        process = frontend.FixtureProcess(
            [args.bun, str(ROOT / "scripts/workbench-metrics-server.ts")], ROOT
        )
        ready = process.ready()
        report["bunVersion"] = ready["bun"]
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                executable_path=args.chromium, headless=True, chromium_sandbox=True
            )
            report["browserVersion"] = browser.version
            try:
                for index in range(4):
                    context = browser.new_context(viewport={"width": 1280, "height": 1024})
                    row = {"warmup": index == 0, "trial": max(0, index - 1), "passed": False}
                    trials.append(row)
                    try:
                        page = context.new_page()
                        page.set_default_timeout(10000)
                        start = time.monotonic()
                        page.goto(ready["origin"], wait_until="domcontentloaded")
                        wait_value(lambda page=page: page.locator("#status").inner_text(), "Ready")
                        row["launchToUsableMs"] = (time.monotonic() - start) * 1000
                        config = context.request.get(ready["origin"] + "/config").json()
                        page.locator("#input").focus()
                        for sequence in range(120):
                            page.keyboard.insert_text("x")
                            wait_value(
                                lambda page=page: page.locator("#measurement-record").get_attribute(
                                    "data-input-count"
                                ),
                                str(sequence + 1),
                            )
                        for _ in range(32):
                            page.locator("#stream").click()
                            wait_value(
                                lambda page=page: page.locator("#status").inner_text(), "Complete"
                            )
                            result = json.loads(page.locator("#results").inner_text())
                            if (
                                result["bytes"] != config["bytes"]
                                or result["checksum"] != config["checksum"]
                            ):
                                raise ValueError("Workload bytes/checksum differ")
                        value = json.loads(page.locator("#measurement-record").text_content())
                        row["measurements"] = validate_trial(value, 120, 32, config["bytes"])
                        row["expectedBytesPerStream"] = config["bytes"]
                        row["passed"] = True
                    finally:
                        context.close()
            finally:
                browser.close()
        report["passed"] = len(trials) == 4 and all(t["passed"] for t in trials)
    except Exception as error:
        report["failure"] = str(error)[-4000:]
    finally:
        if process:
            process.close()
    report["driverSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "passed": report["passed"],
                "executions": len(trials),
                "output": str(destination),
                "failure": report.get("failure"),
            }
        )
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun", required=True)
    parser.add_argument("--chromium", required=True)
    parser.add_argument("--output", required=True)
    raise SystemExit(run(parser.parse_args()))
