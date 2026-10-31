#!/usr/bin/env python3
"""Portable actual-host paint/lifecycle smoke with opt-in owned OS input.

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
MACOS_GPU_TELEMETRY_UNAVAILABLE_REVISION = "ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d"
INPUT_SPEC = importlib.util.spec_from_file_location(
    "native_platform_input", ROOT / "scripts/quality/native-platform-input.py"
)
OS_INPUT = importlib.util.module_from_spec(INPUT_SPEC)
INPUT_SPEC.loader.exec_module(OS_INPUT)


class NativePaintMismatch(RuntimeError):
    """A complete expected native paint did not arrive within its deadline."""


def renderer_telemetry(renderer, operating_system, gpui_revision):
    """Validate the actual window record without inventing unavailable metadata."""
    if (
        renderer.get("type") != "renderer"
        or type(renderer.get("window_id")) is not int
        or renderer["window_id"] <= 0
        or "gpu" not in renderer
    ):
        raise RuntimeError("Actual native renderer record is malformed")
    gpu = renderer["gpu"]
    if gpu is None:
        if (
            operating_system != "Darwin"
            or gpui_revision != MACOS_GPU_TELEMETRY_UNAVAILABLE_REVISION
        ):
            raise RuntimeError("Actual native renderer did not report its adapter")
        return {
            "window_id": renderer["window_id"],
            "status": "unavailable",
            "reason": "The pinned GPUI macOS window returns None from gpu_specs(); adapter identity and software emulation are unverified.",
            "gpuiRevision": gpui_revision,
            "source": f"https://github.com/zed-industries/zed/blob/{gpui_revision}/crates/gpui_macos/src/window.rs",
        }
    if (
        not isinstance(gpu, dict)
        or type(gpu.get("is_software_emulated")) is not bool
        or not isinstance(gpu.get("device_name"), str)
        or not gpu["device_name"]
        or not isinstance(gpu.get("driver_name"), str)
        or not isinstance(gpu.get("driver_info"), str)
    ):
        raise RuntimeError("Actual native renderer adapter metadata is malformed")
    return {"window_id": renderer["window_id"], "status": "reported"}


def source_snapshot():
    sources = {
        Path(relative).as_posix(): value
        for relative, value in DIAGNOSTICS.source_snapshot().items()
    }
    for relative in (
        "tests/native/platform-smoke.ts",
        "examples/native-window/content.ts",
        "scripts/quality/native-platform-smoke.py",
        "scripts/quality/native-platform-input.py",
        "scripts/quality/native-platform-windows.py",
        "scripts/quality/native-platform-macos.m",
    ):
        sources[relative] = DIAGNOSTICS.fingerprint(ROOT / relative)
    return sources


def expected_paint(cycle, updated, nonce, *, os_input=False):
    value = f"Native {cycle} {nonce}" if updated else ""
    label = f"Native update {cycle}" if updated else "Clicks: 0"
    result = EVIDENCE.fixture_paint(2 if updated else 1, label, value)
    result["window_id"] = cycle
    offset = (cycle - 1) * 6
    for node in result["nodes"]:
        node["node_id"] += offset
        node["children"] = [child + offset for child in node["children"]]
    result["nodes"][-1]["input_revision"] = (
        (len(nonce) if os_input else 0) + 1 if updated else 0
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=("development", "aot"))
    parser.add_argument("--host-profile", required=True, choices=("dev", "release"))
    parser.add_argument("--negative-paint-check", action="store_true")
    parser.add_argument("--os-input", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.os_input and args.negative_paint_check:
        parser.error("Run the negative paint guard separately from actual OS input")
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
    gpui_revision = json.loads((ROOT / "toolchain.json").read_text())["gpui"][
        "revision"
    ]
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
        "osInputRequested": args.os_input,
        "scope": "Actual GPUI lifecycle, a native renderer record with explicit adapter telemetry availability, and complete paint traversal; --os-input additionally requires independently owned visible windows and native pointer/Tab/text delivery. No display-presentation, hardware-input, screenshot or complete process-tree claim.",
        "osWindowVisibility": "unverified",
        "osInput": "not-attempted",
        "screenshots": "not-attempted",
        "processTreeCleanup": "unverified",
        "paintObservations": [],
        "renderers": [],
        "rendererTelemetry": [],
        "osObservations": [],
        "logs": {},
    }
    environment = {
        **os.environ,
        "BUN_NATIVE_HOST": str(host),
        "BUN_NATIVE_DIAGNOSTICS_DIR": str(output),
        "BUN_NATIVE_EVIDENCE_LOG": str(output / "native.jsonl"),
        "BUN_NATIVE_EVIDENCE_NONCE": nonce,
        "BUN_NATIVE_PLATFORM_INPUT": "1" if args.os_input else "0",
    }
    app = None
    threads = []
    input_driver = None
    input_errors = (OS_INPUT.InputUnavailable,)
    helper_fingerprint = None
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

    def exercise_input(cycle, initial):
        observation = wait_for(
            lambda: input_driver.observe(f"Bun Native platform smoke {cycle}"),
            "independently owned and visible native window",
        )
        report["osWindowVisibility"] = "observed through target OS window APIs"
        report["osInput"] = "not-yet-verified"
        button_id = initial["nodes"][3]["node_id"]
        input_id = initial["nodes"][-1]["node_id"]

        def latest_layout():
            layouts = [
                row["layout"]
                for row in records("native.jsonl")
                if row.get("type") == "layout"
                and row.get("window_id") == cycle
                and row.get("tree_revision") == 1
            ]
            return layouts[-1] if layouts else None

        layout = wait_for(latest_layout, "actual native input geometry")
        x, y, viewport = OS_INPUT.pointer_target(layout, button_id)
        observation["pointer"] = input_driver.click(x, y, viewport)
        wait_for(
            lambda: (
                OS_INPUT.input_delivery(records("application.jsonl"), cycle, nonce)[
                    "clicks"
                ]
                == 1
            ),
            "actual OS pointer activation at the public button listener",
        )
        observation["tab"] = input_driver.tab()

        def input_focused():
            layout = latest_layout()
            return (
                layout
                and layout.get("focused_node_id") == input_id
                and any(
                    row.get("type") == "os-route"
                    and row.get("cycle") == cycle
                    and row.get("event") == "focus"
                    and row.get("kind") == "input"
                    for row in records("application.jsonl")
                )
            )

        wait_for(input_focused, "actual Tab traversal into the native editor")
        observation["typing"] = input_driver.type_text(nonce)
        wait_for(
            lambda: OS_INPUT.input_delivery(records("application.jsonl"), cycle, nonce)[
                "complete"
            ],
            "every actual OS nonce edit in sequence",
        )
        rows = records("application.jsonl")
        routes = [
            row
            for row in rows
            if row.get("type") == "os-route" and row.get("cycle") == cycle
        ]
        for event in ("pointer_down", "pointer_up"):
            matching = [row for row in routes if row.get("event") == event]
            if (
                len(matching) != 1
                or matching[0].get("kind") != "button"
                or matching[0].get("button") != "left"
            ):
                raise RuntimeError(
                    "Actual native pointer event was missing or misrouted"
                )
        for event in ("key_down", "key_up"):
            if (
                len(
                    [
                        row
                        for row in routes
                        if row.get("event") == event and row.get("key") == "tab"
                    ]
                )
                != 1
            ):
                raise RuntimeError(
                    "Actual native Tab key event was missing or duplicated"
                )
        expected = expected_paint(cycle, False, nonce)
        expected["nodes"][-1]["element"]["value"] = nonce
        expected["nodes"][-1]["input_revision"] = len(nonce)
        painted = wait_for(
            lambda: next(
                (
                    row
                    for row in records("native.jsonl")
                    if EVIDENCE.matches_paint(row, expected)
                ),
                None,
            ),
            "complete native paint retaining every OS edit",
            paint=True,
        )
        report["paintObservations"].append(
            {
                "phase": "os-input",
                "elapsedMs": (time.monotonic() - started) * 1000,
                "paint": painted,
            }
        )
        observation["delivery"] = OS_INPUT.input_delivery(
            rows, cycle, nonce, complete=True
        )
        report["osObservations"].append(observation)

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
        if args.os_input:
            input_driver, extra_errors = OS_INPUT.create(app, host, DIAGNOSTICS)
            input_errors += extra_errors
            if hasattr(input_driver, "helper"):
                helper_fingerprint = DIAGNOSTICS.fingerprint(input_driver.helper)
                report["osHelper"] = {
                    "path": str(input_driver.helper),
                    **helper_fingerprint,
                }
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
                "actual native renderer record",
            )
            report["rendererTelemetry"].append(
                renderer_telemetry(renderer, platform.system(), gpui_revision)
            )
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
                expected = expected_paint(cycle, updated, nonce, os_input=args.os_input)
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
                if args.os_input and not updated:
                    exercise_input(cycle, expected)
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
        if (
            helper_fingerprint
            and DIAGNOSTICS.fingerprint(input_driver.helper) != helper_fingerprint
        ):
            raise RuntimeError(
                "The actual OS helper executable changed during the smoke"
            )
        if args.os_input:
            report["osInput"] = (
                "verified pointer activation, Tab traversal and every nonce edit"
            )
        report["status"] = "passed"
    except input_errors as error:
        report["status"] = "unsupported"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
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
        if input_driver is not None:
            try:
                input_driver.close()
                report["osControllerCleanup"] = "completed"
            except Exception as error:
                report["status"] = "failed"
                report["osControllerCleanup"] = str(error)
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
                report["application"] = json.loads(
                    application_result.read_text(encoding="utf-8")
                )
        except (OSError, ValueError, RuntimeError) as error:
            report["status"] = "failed"
            report["applicationResultError"] = str(error)
        application = report.get("application", {})
        if report["status"] == "passed" and (
            application.get("status") != "passed"
            or application.get("osInput") is not args.os_input
            or application.get("completedCycles") != 3
            or application.get("nativeShutdownAndExitVerified") is not True
            or not application.get("ownership")
            or any(application["ownership"].values())
        ):
            report["status"] = "failed"
        report["nativeShutdownAndExitVerified"] = application.get(
            "nativeShutdownAndExitVerified", False
        )
        (output / "result.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n"
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
