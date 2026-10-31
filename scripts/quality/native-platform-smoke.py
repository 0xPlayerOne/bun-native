#!/usr/bin/env python3
"""Portable actual-host paint/lifecycle smoke; no OS visibility/input claim.

Reuses the native diagnostic driver's pure log, fingerprint and full-tree
expectation helpers. Its Linux process/input functions are never called here.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import secrets
import signal
import subprocess
import threading
import time


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_diagnostics", ROOT / "scripts/quality/native-diagnostics-linux.py"
)
DIAGNOSTICS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAGNOSTICS)
EVIDENCE = DIAGNOSTICS.DRIVER


class NativePaintMismatch(RuntimeError):
    """A complete expected native paint did not arrive within its deadline."""


def source_snapshot():
    sources = DIAGNOSTICS.source_snapshot()
    for relative in (
        "tests/native/platform-smoke.ts",
        "examples/native-window/content.ts",
        "scripts/quality/native-platform-smoke.py",
    ):
        sources[relative] = DIAGNOSTICS.fingerprint(ROOT / relative)
    return sources


def expected_paint(cycle, updated, nonce):
    value = f"Native {cycle} {nonce}" if updated else ""
    label = f"Native update {cycle}" if updated else "Clicks: 0"
    result = EVIDENCE.fixture_paint(2 if updated else 1, label, value)
    result["window_id"] = cycle
    offset = (cycle - 1) * 6
    for node in result["nodes"]:
        node["node_id"] += offset
        node["children"] = [child + offset for child in node["children"]]
    result["nodes"][-1]["input_revision"] = 1 if updated else 0
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=("development", "aot"))
    parser.add_argument("--host-profile", required=True, choices=("dev", "release"))
    parser.add_argument("--negative-paint-check", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    host = Path(os.environ.get("BUN_NATIVE_HOST", ""))
    if not command or not host.is_absolute() or not host.is_file():
        parser.error(
            "Supply an explicit fixture command and absolute prebuilt BUN_NATIVE_HOST"
        )
    host = host.resolve()
    args.output.mkdir()
    output = args.output.resolve()
    nonce = secrets.token_hex(16)
    sources = source_snapshot()
    fingerprint = DIAGNOSTICS.fingerprint(host)
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "scenario": "platform-smoke",
        "mode": args.mode,
        "aotVerifiedByDriver": False,
        "hostProfile": args.host_profile,
        "host": {"path": str(host), **fingerprint},
        "command": command,
        "system": {"platform": platform.platform(), "architecture": platform.machine()},
        "sourceFiles": sources,
        "negativePaintCheck": args.negative_paint_check,
        "scope": "Actual GPUI protocol lifecycle, native renderer metadata and complete paint traversal. No OS-visible-window, display-presentation or physical input observation.",
        "osWindowVisibility": "unverified",
        "osInput": "not-attempted",
        "screenshots": "not-attempted",
        "processTreeCleanup": "unverified",
        "paintObservations": [],
        "renderers": [],
        "logs": {},
    }
    environment = {
        **os.environ,
        "BUN_NATIVE_HOST": str(host),
        "BUN_NATIVE_DIAGNOSTICS_DIR": str(output),
        "BUN_NATIVE_EVIDENCE_LOG": str(output / "native.jsonl"),
        "BUN_NATIVE_EVIDENCE_NONCE": nonce,
    }
    app = None
    threads = []
    started = time.monotonic()

    def interrupt(signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise InterruptedError(f"Native platform smoke received signal {signum}")

    signal.signal(signal.SIGTERM, interrupt)

    def records(name):
        return EVIDENCE.read_events(output / name, nonce, 0)

    def wait_for(predicate, description, timeout=10, paint=False):
        deadline = min(started + 40, time.monotonic() + timeout)
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            if app.poll() is not None:
                raise RuntimeError(
                    f"Fixture exited {app.returncode} before {description}"
                )
            time.sleep(0.02)
        error = NativePaintMismatch if paint else RuntimeError
        raise error("Timed out waiting for " + description)

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
        for cycle in range(1, 4):
            wait_for(
                lambda: any(
                    row.get("type") == "mounted" and row.get("cycle") == cycle
                    for row in records("application.jsonl")
                ),
                "mounted native tree",
            )
            renderer = wait_for(
                lambda: next(
                    (
                        row
                        for row in records("native.jsonl")
                        if row.get("type") == "renderer"
                        and row.get("window_id") == cycle
                    ),
                    None,
                ),
                "actual native renderer metadata",
            )
            gpu = renderer.get("gpu")
            if (
                not isinstance(gpu, dict)
                or type(gpu.get("is_software_emulated")) is not bool
                or not isinstance(gpu.get("device_name"), str)
                or not gpu["device_name"]
            ):
                raise RuntimeError("Actual native renderer did not report its adapter")
            report["renderers"].append(renderer)
            for updated in (False, True):
                if updated:
                    (output / f"update-{cycle}").touch()
                    wait_for(
                        lambda: any(
                            row.get("type") == "updated" and row.get("cycle") == cycle
                            for row in records("application.jsonl")
                        ),
                        "acknowledged native update",
                    )
                expected = expected_paint(cycle, updated, nonce)
                if args.negative_paint_check:
                    expected["nodes"][2]["element"]["text"] = (
                        "Deliberate invalid paint expectation"
                    )
                painted = wait_for(
                    lambda: next(
                        (
                            row
                            for row in records("native.jsonl")
                            if EVIDENCE.matches_paint(row, expected)
                        ),
                        None,
                    ),
                    "complete native paint",
                    timeout=2 if args.negative_paint_check else 10,
                    paint=True,
                )
                report["paintObservations"].append(
                    {"elapsedMs": (time.monotonic() - started) * 1000, "paint": painted}
                )
            (output / f"close-{cycle}").touch()
            wait_for(
                lambda: any(
                    row.get("type") == "cycle-closed" and row.get("cycle") == cycle
                    for row in records("application.jsonl")
                ),
                "native close and public revocation",
            )
        wait_for(lambda: app.poll() is not None, "application shutdown", timeout=5)
        if app.wait(timeout=1) != 0:
            raise RuntimeError("The native smoke application failed")
        if source_snapshot() != sources or DIAGNOSTICS.fingerprint(host) != fingerprint:
            raise RuntimeError("Native source or executable changed during the smoke")
        report["status"] = "passed"
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        # The trusted fixture checks abort while awaiting every private command,
        # then joins the runtime's bounded native shutdown and child exit.
        (output / "abort").touch()
        forced = False
        if app is not None:
            try:
                app.wait(timeout=12)
            except subprocess.TimeoutExpired:
                forced = True
                app.terminate()
                try:
                    app.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    app.kill()
                    app.wait(timeout=3)
            report["applicationExitCode"] = app.returncode
        report["forcedApplicationTermination"] = forced
        for thread in threads:
            thread.join(timeout=1)
        if (
            forced
            or any(thread.is_alive() for thread in threads)
            or any(stats["discarded_bytes"] for stats in report["logs"].values())
        ):
            report["status"] = "failed"
        application_result = output / "application-result.json"
        try:
            if application_result.exists():
                if application_result.stat().st_size > EVIDENCE.MAX_LOG_BYTES:
                    raise RuntimeError("Application result exceeded its evidence bound")
                report["application"] = json.loads(application_result.read_text())
        except (OSError, ValueError, RuntimeError) as error:
            report["status"] = "failed"
            report["applicationResultError"] = str(error)
        application = report.get("application", {})
        if report["status"] == "passed" and (
            application.get("status") != "passed"
            or application.get("completedCycles") != 3
            or application.get("nativeShutdownAndExitVerified") is not True
            or not application.get("ownership")
            or any(application["ownership"].values())
        ):
            report["status"] = "failed"
        report["nativeShutdownAndExitVerified"] = application.get(
            "nativeShutdownAndExitVerified", False
        )
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
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
