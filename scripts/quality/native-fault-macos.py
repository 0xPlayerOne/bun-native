"""macOS native fault containment for the real GPUI host (issue #247).

Drives tests/native/fault.ts (`host-crash`) the way native-diagnostics-linux.py
does on X11, with macOS process and input primitives: a real OS pointer
activation parks a public callback, the owned host is stopped (SIGSTOP), two
batches queue behind it, then the host is killed (SIGKILL). The fixture proves
one shared transport failure, an aborted callback and zero ownership. Process
identity (PID, start time, executable path) is rechecked before every signal.
Startup failure by invalid display has no macOS equivalent and is not claimed.
"""

import argparse
import importlib.util
import json
import logging
import os
import platform
import secrets
import signal
import subprocess
import threading
import time
from pathlib import Path

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]
TITLE = "Bun Native native fault"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DIAGNOSTICS = load("native_diagnostics", "scripts/quality/native-diagnostics-linux.py")
EVIDENCE = DIAGNOSTICS.DRIVER
OS_INPUT = load("native_platform_input", "scripts/quality/native-platform-input.py")


def process_table():
    """pid -> {ppid, state, started, executable}. `ps` is the macOS source of truth."""
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,state=,lstart=,comm="],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    )
    table = {}
    for line in result.stdout.splitlines():
        parts = line.split(None, 8)
        if len(parts) < 9:
            continue
        pid, ppid, state, *started, executable = (
            parts[0],
            parts[1],
            parts[2],
            *parts[3:8],
            parts[8],
        )
        table[int(pid)] = {
            "pid": int(pid),
            "ppid": int(ppid),
            "state": state,
            "started": " ".join(started),
            "executable": executable,
        }
    return table


def owned_processes(root_pid, table):
    owned, frontier = set(), {root_pid}
    while frontier:
        children = (
            {pid for pid, row in table.items() if row["ppid"] in frontier}
            - owned
            - {root_pid}
        )
        owned |= children
        frontier = children
    return [table[pid] for pid in sorted(owned)]


def host_row(app, host, observed):
    """The one owned live process whose executable is exactly the supplied host."""
    table = process_table()
    matches = [
        row
        for row in owned_processes(app.pid, table)
        if Path(row["executable"]).resolve() == host and row["state"][0] != "Z"
    ]
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected exactly one owned native host, found {len(matches)}"
        )
    row = matches[0]
    if observed.setdefault(row["pid"], row["started"]) != row["started"]:
        raise RuntimeError("Native host process identity changed")
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=("development", "aot"))
    parser.add_argument(
        "--no-os-click",
        action="store_true",
        help="Skip the callback case when CoreGraphics event posting is not permitted",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    host = Path(os.environ.get("BUN_NATIVE_HOST", ""))
    if platform.system() != "Darwin":
        parser.error("This driver requires macOS")
    if not command or not host.is_absolute() or not host.is_file():
        parser.error("Supply a fixture command and absolute prebuilt BUN_NATIVE_HOST")
    host = host.resolve()
    args.output.mkdir()
    output = args.output.resolve()
    nonce = secrets.token_hex(16)
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "scenario": "host-crash",
        "platform": "macos",
        "mode": args.mode,
        "host": {"path": str(host), **DIAGNOSTICS.fingerprint(host)},
        "command": command,
        "system": {
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "macos": platform.mac_ver()[0],
        },
        "sourceFiles": {
            relative: DIAGNOSTICS.fingerprint(ROOT / relative)
            for relative in (
                "tests/native/fault.ts",
                "scripts/quality/native-fault-macos.py",
                "scripts/quality/native-platform-input.py",
                "scripts/quality/native-platform-macos.m",
            )
        },
        "scope": "Actual GPUI host on macOS: a real OS pointer activation parks a public callback, the owned host is SIGSTOPped then SIGKILLed with two queued batches. Transport failure containment only; a GPUI-internal panic, crash dumps and startup failure by invalid display are not covered.",
        "osClick": "not-run (--no-os-click: CoreGraphics event posting unavailable)"
        if args.no_os_click
        else "required",
        "signals": [],
        "logs": {},
    }
    environment = {
        **os.environ,
        "BUN_NATIVE_HOST": str(host),
        "BUN_NATIVE_DIAGNOSTICS_DIR": str(output),
        "BUN_NATIVE_DIAGNOSTICS_SCENARIO": "host-crash",
        "BUN_NATIVE_EVIDENCE_LOG": str(output / "native.jsonl"),
        "BUN_NATIVE_EVIDENCE_NONCE": nonce,
        "BUN_NATIVE_FAULT_OS_CLICK": "0" if args.no_os_click else "1",
    }
    started = time.monotonic()
    observed = {}
    threads = []
    app = None

    def records(name):
        return EVIDENCE.read_events(output / name, nonce, 0)

    def wait_for(predicate, description, timeout=10):
        deadline = min(started + 40, time.monotonic() + timeout)
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            if app.poll() is not None:
                value = predicate()
                if value:
                    return value
                raise RuntimeError(
                    f"Fixture exited {app.returncode} before {description}"
                )
            time.sleep(0.02)
        raise RuntimeError("Timed out waiting for " + description)

    def application_record(kind):
        return next(
            (row for row in records("application.jsonl") if row.get("type") == kind),
            None,
        )

    try:
        app = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        for name, stream in (("stdout", app.stdout), ("stderr", app.stderr)):
            stats = {"written_bytes": 0, "discarded_bytes": 0}
            report["logs"][name] = stats
            thread = threading.Thread(
                target=EVIDENCE.capture,
                args=(stream, output / (name + ".log"), stats),
                daemon=True,
            )
            thread.start()
            threads.append(thread)
        mounted = wait_for(lambda: application_record("mounted"), "mounted native tree")
        if not args.no_os_click:
            input_driver = OS_INPUT.MacInput(app.pid, host)
            report["osHelper"] = {
                "path": str(input_driver.helper),
                **DIAGNOSTICS.fingerprint(input_driver.helper),
            }
            observation = dict(
                wait_for(
                    lambda: input_driver.observe(TITLE),
                    "independently owned and visible native window",
                )
            )
            report["osObservation"] = observation
            layout = wait_for(
                lambda: next(
                    (
                        row["layout"]
                        for row in reversed(records("native.jsonl"))
                        if row.get("type") == "layout"
                        and row.get("tree_revision", 1)
                        >= mounted.get("treeRevision", 1)
                        and row["layout"].get("status") == "complete"
                    ),
                    None,
                ),
                "actual native input geometry",
            )
            button = max(layout["nodes"], key=lambda node: node["node_id"])
            x, y, viewport = OS_INPUT.pointer_target(layout, button["node_id"])
            report["pointerTarget"] = {"nodeId": button["node_id"], "point": [x, y]}
            report["pointer"] = input_driver.click(x, y, viewport)
            report["launchCallback"] = wait_for(
                lambda: application_record("callback-waiting"), "real OS-click callback"
            )
        row = host_row(app, host, observed)
        os.kill(row["pid"], signal.SIGSTOP)
        report["signals"].append(
            {"pid": row["pid"], "started": row["started"], "signal": "SIGSTOP"}
        )
        wait_for(
            lambda: host_row(app, host, observed)["state"][0] == "T",
            "stopped native child",
            2,
        )
        (output / "queue-after-stop").touch()
        pending = wait_for(
            lambda: application_record("pending"), "pending application work"
        )
        ownership = pending.get("ownership", {})
        if ownership.get("queuedTransactions") != 2 or ownership.get(
            "activeCallbacks"
        ) != (0 if args.no_os_click else 1):
            raise RuntimeError(
                "The transaction/callback fault preconditions were not established"
            )
        row = host_row(app, host, observed)
        os.kill(row["pid"], signal.SIGKILL)
        report["signals"].append(
            {"pid": row["pid"], "started": row["started"], "signal": "SIGKILL"}
        )
        report["containment"] = wait_for(
            lambda: application_record("crash-contained"),
            "precise native fault containment",
        )
        wait_for(lambda: app.poll() is not None, "fixture exit", timeout=10)
        if app.returncode != 0:
            raise RuntimeError(f"The fault fixture exited {app.returncode}")
        survivors = [
            r
            for r in owned_processes(os.getpid(), process_table())
            if Path(r["executable"]).resolve() == host
        ]
        report["hostSurvivors"] = len(survivors)
        if survivors:
            raise RuntimeError("The native host outlived the contained fault")
        report["status"] = "passed"
    except Exception as error:
        LOGGER.exception("macOS native fault failed")
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if app is not None:
            if app.poll() is None:
                (output / "abort").touch()
                try:
                    app.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    app.kill()
                    app.wait(timeout=3)
                    report["status"] = "failed"
            report["applicationExitCode"] = app.returncode
        for thread in threads:
            thread.join(timeout=1)
        if any(stats["discarded_bytes"] for stats in report["logs"].values()):
            report["status"] = "failed"
        result = output / "application-result.json"
        if result.exists():
            report["application"] = json.loads(result.read_text(encoding="utf-8"))
        if (
            report["status"] == "passed"
            and report.get("application", {}).get("status") != "passed"
        ):
            report["status"] = "failed"
        (output / "result.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
    print(
        json.dumps(
            {
                "status": report["status"],
                "mode": args.mode,
                "report": str(output / "result.json"),
                "error": report.get("error"),
            }
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
