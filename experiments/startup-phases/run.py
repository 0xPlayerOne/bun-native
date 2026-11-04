"""Observe one unchanged lifecycle process; preserve failure and unfinished phases."""

import importlib.util
import json
import os
import re
import secrets
import subprocess
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "startup_prepare", Path(__file__).with_name("prepare.py")
)
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)
SPEC = importlib.util.spec_from_file_location(
    "native_input_linux", ROOT / "scripts/quality/native-input-linux.py"
)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)
PHASES = {
    "x11_colormap",
    "x11_setup",
    "renderer",
    "instance",
    "surface_create",
    "enumerate",
    "surface_caps",
    "device_request",
    "surface_configuration",
    "surface_configure",
    "error_scope",
}


def first_open_phases(records, nonce):
    """Report only this host's first open; never subtract different clock origins."""
    if any(not isinstance(row, dict) or row.get("nonce") != nonce for row in records):
        raise ValueError("Trace contains a foreign correlation ID or invalid record")
    request = next(
        (
            row
            for row in records
            if row.get("source") == "transport"
            and row.get("phase") == "request_queued"
            and row.get("command") == "open"
        ),
        None,
    )
    if request is None:
        raise ValueError("Trace has no first open request")
    host_pid = request["host_pid"]
    if type(host_pid) is not int or host_pid <= 0:
        raise ValueError("First open has no valid host identity")
    stack = []
    phases = []
    durations = []
    previous_ns = -1
    capture_complete = True
    first_open_returned = False
    for row in records:
        if row.get("pid") != host_pid:
            continue
        if (
            row.get("source") == "native"
            and row.get("request_id") == request["request_id"]
            and row.get("phase") == "open_window_returned"
        ):
            first_open_returned = True
            break
        if row.get("source") != "native-log":
            continue
        if (
            "limit" in str(row.get("phase", ""))
            or row.get("truncated")
            or row.get("format_error")
            or row.get("message_omitted")
        ):
            capture_complete = False
        message = str(row.get("message", ""))
        if not message.startswith("BN_PHASE "):
            continue
        match = re.fullmatch(r"BN_PHASE ([a-z0-9_]+)_(enter|return|error)", message)
        if match is None or match[1] not in PHASES:
            raise ValueError(f"Unknown phase marker: {message}")
        elapsed = str(row.get("elapsed_ns", ""))
        if not elapsed.isdecimal() or int(elapsed) < previous_ns:
            raise ValueError("Native logger clock is missing or nonmonotonic")
        previous_ns = int(elapsed)
        phase = {"phase": match[1], "boundary": match[2], "elapsedNs": elapsed}
        phases.append(phase)
        if match[2] == "enter":
            stack.append(phase)
        elif not stack or stack[-1]["phase"] != match[1]:
            raise ValueError(f"Unmatched phase return: {message}")
        else:
            entered = stack.pop()
            durations.append(
                {
                    "phase": match[1],
                    "outcome": "error" if match[2] == "error" else "ok",
                    "durationNs": str(int(elapsed) - int(entered["elapsedNs"])),
                }
            )
    if not phases:
        raise ValueError("No internal phase markers were captured for the owned host")
    expected_timeout = f"Native open request {request['request_id']} timed out"
    timed_out = any(
        row.get("source") == "transport"
        and row.get("pid") == request["pid"]
        and row.get("phase") == "transport_failed"
        and row.get("error") == expected_timeout
        for row in records
    )
    opened = any(
        row.get("source") == "transport"
        and row.get("pid") == request["pid"]
        and row.get("phase") == "response_received"
        and row.get("request_id") == request["request_id"]
        and row.get("response") == "opened"
        for row in records
    )
    return {
        "hostPid": host_pid,
        "requestId": request["request_id"],
        "firstOpenTimedOut": timed_out,
        "firstOpenAcknowledged": opened,
        "nativeOpenCallReturned": first_open_returned,
        "captureComplete": capture_complete,
        "phases": phases,
        "completedPhaseDurations": durations,
        "unfinishedPhases": stack,
        "innermostUnfinishedPhase": stack[-1]["phase"] if stack else None,
        "interpretation": (
            "Unfinished means no return marker was observed, not a proven deadlock. "
            "Only native-log timestamps were used for phase durations."
        ),
    }


def verify_sources(plan, root):
    if PREPARE.source_hashes(ROOT) != plan["sourceSha256"]:
        raise ValueError("Experiment, runtime, fixture or configuration source changed")
    dependency = Path(plan["dependency"]).resolve()
    if not dependency.is_relative_to(root / "cargo"):
        raise ValueError("Instrumented dependency left the private Cargo home")
    for row in plan["files"]:
        if (
            PREPARE.digest((dependency / row["path"]).read_bytes())
            != row["instrumentedSha256"]
        ):
            raise ValueError(f"Instrumented source changed: {row['path']}")


def main():
    root = Path(os.environ["STARTUP_PHASE_ROOT"]).resolve()
    output = root / "evidence"
    plan = json.loads((output / "plan.json").read_text())
    verify_sources(plan, root)
    if not DRIVER.proc_identity_matches():
        raise DRIVER.Unsupported("The current PID namespace does not match /proc")
    DRIVER.enable_subreaper()
    host = ROOT / "target/release/bun-native-host"
    host_hash = PREPARE.digest(host.read_bytes())
    identity = {
        "hostSha256": host_hash,
        "hostBytes": host.stat().st_size,
        "bunRevision": subprocess.check_output(
            ["bun", "--revision"], text=True
        ).strip(),
        "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip(),
        "scope": "One instrumented release-host observation; not native acceptance",
    }
    (output / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    nonce = secrets.token_hex(16)
    with (output / "attempt-started.json").open("x") as stream:
        json.dump(
            {
                "trial": plan["trial"],
                "nonce": nonce,
                "command": ["bun", "tests/native/lifecycle.ts"],
            },
            stream,
            indent=2,
        )
        stream.write("\n")
    environment = dict(os.environ)
    environment.update(
        BUN_NATIVE_HOST=str(host),
        BUN_NATIVE_HOST_PROFILE="release",
        BUN_NATIVE_STARTUP_LOG="1",
        BUN_NATIVE_STARTUP_TRACE="1",
        BUN_NATIVE_EVIDENCE_LOG=str(output / "startup.jsonl"),
        BUN_NATIVE_EVIDENCE_NONCE=nonce,
    )
    result = {
        "scope": "Research observation, never Validation / Gate qualification",
        "trial": plan["trial"],
        "status": "failed",
        "outerDeadlineExceeded": False,
        "phaseClockWarning": "Native and transport clocks are separately relative",
    }
    started = time.monotonic()
    observed = {}
    stats = {"written_bytes": 0, "discarded_bytes": 0}
    app = subprocess.Popen(
        ["bun", "tests/native/lifecycle.ts"],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    capture = threading.Thread(
        target=DRIVER.capture,
        args=(app.stdout, output / "lifecycle.log", stats),
        daemon=True,
    )
    capture.start()
    try:
        while app.poll() is None:
            observed.update(
                {
                    row["pid"]: row["start_ticks"]
                    for row in DRIVER.owned_processes(app.pid, DRIVER.process_table())
                }
            )
            if stats["discarded_bytes"]:
                raise RuntimeError("Lifecycle output exceeded the existing 4 MiB bound")
            remaining = 45 - (time.monotonic() - started)
            if remaining <= 0:
                result["outerDeadlineExceeded"] = True
                break
            try:
                app.wait(timeout=min(0.05, remaining))
            except subprocess.TimeoutExpired:
                pass
    except (OSError, RuntimeError) as error:
        result["supervisorError"] = str(error)
    finally:
        observed.update(
            {
                row["pid"]: row["start_ticks"]
                for row in DRIVER.owned_processes(app.pid, DRIVER.process_table())
            }
        )
        result["cleanup"] = DRIVER.cleanup(app, observed)
        capture.join(timeout=3)
        result["outputCaptureJoined"] = not capture.is_alive()
        if not capture.is_alive():
            app.stdout.close()
        result["exitCode"] = app.poll()
        result["durationSeconds"] = time.monotonic() - started
        result["outputBytes"] = stats
    try:
        trace = output / "startup.jsonl"
        if trace.stat().st_size > 1048576:
            raise ValueError("Startup evidence exceeded the 1 MiB bound")
        data = trace.read_bytes()
        if not data.endswith(b"\n"):
            raise ValueError("Startup trace ends in a partial record")
        records = [json.loads(line) for line in data.splitlines()]
        result["firstOpen"] = first_open_phases(records, nonce)
        verify_sources(plan, root)
        if PREPARE.digest(host.read_bytes()) != host_hash:
            raise ValueError("Native binary changed during execution")
        result["evidenceStatus"] = "complete"
    except (OSError, ValueError, KeyError, TypeError) as error:
        result["evidenceStatus"] = "incomplete"
        result["evidenceError"] = str(error)
    cleanup = result["cleanup"]
    first = result.get("firstOpen", {})
    if (
        result["exitCode"] == 0
        and not result["outerDeadlineExceeded"]
        and not result.get("supervisorError")
        and result["evidenceStatus"] == "complete"
        and result["outputCaptureJoined"]
        and not stats["discarded_bytes"]
        and not cleanup["forced_termination"]
        and not cleanup["remaining_observed_pids"]
        and not cleanup["unreaped_observed_pids"]
        and first.get("captureComplete")
        and first.get("firstOpenAcknowledged")
        and not first.get("unfinishedPhases")
    ):
        result["status"] = "passed"
    (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2), flush=True)
    raise SystemExit(0 if result["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
