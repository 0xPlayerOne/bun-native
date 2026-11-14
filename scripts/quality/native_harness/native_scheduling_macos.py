"""Exercise bounded GPUI command load and real macOS input/paint concurrently."""

import argparse
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

from . import native_diagnostics_linux as diagnostics
from . import native_fault_macos as ownership
from . import native_platform_input as os_input
from .common import ROOT, harness_sources

LOGGER = logging.getLogger(__name__)
EVIDENCE = diagnostics.DRIVER
TITLE = "Bun Native scheduling audit"


def paint_progress(native_records, mounted_revision):
    """A later native paint traversal, observed while the producer is active."""
    return any(
        row.get("type") == "rendered" and row.get("tree_revision", 0) > mounted_revision
        for row in native_records
    )


def observed_paint_during(before, native, after, mounted_revision):
    """Bracket a paint-log read with producer-active application observations."""

    def active(records):
        return any(row.get("type") == "stream-start" for row in records) and not any(
            row.get("type") == "producer-stopped" for row in records
        )

    return active(before) and active(after) and paint_progress(native, mounted_revision)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=("development", "aot"))
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
    sources = {
        path: diagnostics.fingerprint(ROOT / path)
        for path in (
            "tests/native/scheduling.ts",
            *harness_sources(),
            "scripts/quality/native-platform-macos.m",
        )
    }
    host_fingerprint = diagnostics.fingerprint(host)
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "scenario": "scheduling",
        "mode": args.mode,
        "host": {"path": str(host), **host_fingerprint},
        "sourceFiles": sources,
        "command": command,
        "system": {"platform": platform.platform(), "architecture": platform.machine()},
        "scope": "Actual macOS GPUI host, bounded command stream, guarded CoreGraphics input and native paint traversal; paint is not display presentation.",
        "logs": {},
    }
    environment = {
        **os.environ,
        "BUN_NATIVE_HOST": str(host),
        "BUN_NATIVE_DIAGNOSTICS_DIR": str(output),
        "BUN_NATIVE_DIAGNOSTICS_SCENARIO": "scheduling",
        "BUN_NATIVE_SCHEDULING_GEOMETRY_GATE": "1",
        "BUN_NATIVE_EVIDENCE_LOG": str(output / "native.jsonl"),
        "BUN_NATIVE_EVIDENCE_NONCE": nonce,
    }
    started = time.monotonic()
    observed = {}
    threads = []
    app = None

    def records(name):
        return EVIDENCE.read_events(output / name, nonce, 0)

    def application_record(kind):
        return next(
            (row for row in records("application.jsonl") if row.get("type") == kind),
            None,
        )

    def wait_for(predicate, description, timeout=15):
        deadline = min(started + 90, time.monotonic() + timeout)
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            if app.poll() is not None:
                raise RuntimeError(
                    f"Fixture exited {app.returncode} before {description}"
                )
            time.sleep(0.01)
        raise RuntimeError("Timed out waiting for " + description)

    try:
        app = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            start_new_session=True,
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
        geometry = wait_for(
            lambda: application_record("geometry-ready"), "input geometry gate"
        )
        driver = os_input.MacInput(app.pid, host)
        report["osHelper"] = {
            "path": str(driver.helper),
            **diagnostics.fingerprint(driver.helper),
        }
        report["osObservation"] = wait_for(
            lambda: driver.observe(TITLE), "owned visible window"
        )
        layout = wait_for(
            lambda: next(
                (
                    row["layout"]
                    for row in reversed(records("native.jsonl"))
                    if row.get("type") == "layout"
                    and row.get("tree_revision", 0) >= geometry["treeRevision"]
                    and row["layout"].get("status") == "complete"
                ),
                None,
            ),
            "complete input layout",
        )
        x, y, viewport = os_input.pointer_target(layout, 6)
        ownership.host_row(app, host, observed)
        driver.click(x, y, viewport)
        (output / "geometry-continue").touch()
        mounted = wait_for(lambda: application_record("mounted"), "mounted native tree")
        (output / "start").touch()
        report["saturation"] = wait_for(
            lambda: application_record("saturated"), "saturated command queue"
        )
        # Ignore earlier paints: only evidence appended after saturation can
        # establish progress during this bounded producer.
        paint_start = len(records("native.jsonl"))
        ownership.host_row(app, host, observed)
        injected = time.monotonic()
        driver.type_text("x")
        report["injectionDurationMs"] = (time.monotonic() - injected) * 1000
        painted_during = False
        while not application_record("completed"):
            before = records("application.jsonl")
            native = records("native.jsonl")[paint_start:]
            after = records("application.jsonl")
            painted_during |= observed_paint_during(
                before, native, after, mounted["treeRevision"]
            )
            if app.poll() is not None:
                raise RuntimeError(f"Fixture exited {app.returncode} before completion")
            if time.monotonic() >= started + 90:
                raise RuntimeError("Timed out waiting for bounded stream")
            time.sleep(0.01)
        if not painted_during:
            raise RuntimeError(
                "No native paint traversal observed during the active producer"
            )
        final_revision = application_record("completed")["treeRevision"]
        expected = EVIDENCE.fixture_paint(final_revision, "Stream completed", "x")
        expected["nodes"][0]["children"] = [3, 2, 4, 5, 6]
        expected["nodes"][1]["element"]["text"] = "Scheduling audit"
        wait_for(
            lambda: any(
                EVIDENCE.matches_paint(row, expected) for row in records("native.jsonl")
            ),
            "complete final native paint",
        )
        report["paintDuringProducerObserved"] = painted_during
        (output / "close").touch()
        wait_for(lambda: app.poll() is not None, "fixture exit")
        if app.returncode != 0:
            raise RuntimeError(f"Fixture exited {app.returncode}")
        result = output / "application-result.json"
        if result.stat().st_size > EVIDENCE.MAX_LOG_BYTES:
            raise RuntimeError("Application result exceeded its evidence bound")
        report["application"] = json.loads(result.read_text(encoding="utf-8"))
        if (
            report["application"].get("status") != "passed"
            or report["application"].get("scenario") != "scheduling"
        ):
            raise RuntimeError("Fixture did not attest the scheduling scenario")
        if diagnostics.fingerprint(host) != host_fingerprint or any(
            diagnostics.fingerprint(ROOT / path) != fingerprint
            for path, fingerprint in sources.items()
        ):
            raise RuntimeError("Host or source changed during the diagnostic")
        survivors = [
            row
            for row in ownership.process_table().values()
            if row["pid"] in observed
            and row["started"] == observed[row["pid"]]
            and Path(row["executable"]).resolve() == host
            and row["state"][0] != "Z"
        ]
        report["hostSurvivors"] = len(survivors)
        if survivors:
            raise RuntimeError("The owned native host outlived the fixture")
        report["status"] = "passed"
    except Exception as error:
        LOGGER.exception("macOS scheduling diagnostic failed")
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if app is not None:
            if app.poll() is None:
                # This is a new session owned by this launch, never the caller's process group.
                os.killpg(app.pid, signal.SIGTERM)
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(app.pid, signal.SIGKILL)
                    app.wait(timeout=5)
                report["status"] = "failed"
                report["forcedCleanup"] = True
            report["applicationExitCode"] = app.returncode
        # A failed fixture may exit before reaping its host. Signal only a
        # previously observed PID whose start time and executable still match.
        for pid, process_start in observed.items():
            row = ownership.process_table().get(pid)
            if (
                row
                and row["started"] == process_start
                and row["state"][0] != "Z"
                and Path(row["executable"]).resolve() == host
            ):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                report["forcedCleanup"] = True
                report["status"] = "failed"
        for thread in threads:
            thread.join(timeout=2)
        if any(thread.is_alive() for thread in threads) or any(
            stats["discarded_bytes"] for stats in report["logs"].values()
        ):
            report["status"] = "failed"
        (output / "result.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
    print(
        json.dumps(
            {
                "status": report["status"],
                "report": str(output / "result.json"),
                "error": report.get("error"),
            }
        )
    )
    return 0 if report["status"] == "passed" else 1
