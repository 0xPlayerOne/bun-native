#!/usr/bin/env python3
"""Bounded streaming/virtualization soak through one real adapter (#257).

Run inside scripts/quality/native-linux-session.sh. The fixture streams a
versioned deterministic workload over a 10,000-message history while this
owned X11 controller detaches, selects, restyles, re-densifies, resizes and
re-follows it with real XTest input, then closes it through the window
manager. Process ownership, nonce-bound logs and cleanup reuse the native input
driver. Measurements are recorded as baselines; the only assertions are
correctness, structural bounds and cleanup.
"""

import argparse
import hashlib
import importlib.util
import itertools
import json
import logging
import math
import os
import platform
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_input_linux", ROOT / "scripts/quality/native-input-linux.py"
)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)

FRAMEWORKS = {"solid": "Solid", "react": "React"}
# Theme background tokens from tests/native/streaming-list-model.ts.
DARK_BACKGROUND = "101820"
LIGHT_BACKGROUND = "f4f6f8"
# Window geometry from the fixture: 960x640, 12 px frame padding, 220 px
# sidebar, 12 px gap, 24 px header and 8 px gap; comfortable rows are 56 px
# with 6 px gaps and a detached list is top-aligned.
ROW_CLICK = (520, 44 + 2 * (56 + 6) + 28)
PROCESS_SAMPLE_SECONDS = 0.1
STREAM_TIMEOUT_SECONDS = 90
SOURCES = (
    "benchmarks/streaming-list-fixture.ts",
    "tests/native/streaming-list-model.ts",
    "tests/native/renderer-streaming-list.ts",
    "tests/native/solid-streaming-list.tsx",
    "tests/native/react-streaming-list.tsx",
    "tests/native/streaming-list.py",
    "scripts/quality/native-input-linux.py",
    "native/gpui-host/src/evidence/frames.rs",
    "native/gpui-host/src/evidence.rs",
    "native/gpui-host/src/view.rs",
)


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "bytes": path.stat().st_size}


def distribution(values):
    """Nearest-rank distribution; empty input yields nulls, never zeros."""
    ordered = sorted(values)

    def rank(fraction):
        if not ordered:
            return None
        return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]

    return {
        "count": len(ordered),
        "p50": rank(0.5),
        "p95": rank(0.95),
        "p99": rank(0.99),
        "max": ordered[-1] if ordered else None,
    }


FRAME_BUCKETS_MS = (8.4, 16.7, 33.4, 50.0, 100.0)


def frame_summary(frames, window_id):
    """Paint-callback cadence for one window. Not presentation timing."""
    rows = [
        row
        for row in frames
        if row.get("type") == "frame" and row.get("window_id") == window_id
    ]
    times = [int(row["elapsed_ns"]) / 1e6 for row in rows]
    intervals = [later - earlier for earlier, later in itertools.pairwise(times)]
    if any(interval < 0 for interval in intervals):
        raise RuntimeError("Native frame records are not monotonic")
    buckets = {f"<={limit}ms": 0 for limit in FRAME_BUCKETS_MS}
    buckets[f">{FRAME_BUCKETS_MS[-1]}ms"] = 0
    for interval in intervals:
        for limit in FRAME_BUCKETS_MS:
            if interval <= limit:
                buckets[f"<={limit}ms"] += 1
                break
        else:
            buckets[f">{FRAME_BUCKETS_MS[-1]}ms"] += 1
    span = times[-1] - times[0] if len(times) > 1 else 0
    return {
        "frames": len(rows),
        "spanMs": span,
        "framesPerSecond": (len(rows) - 1) * 1000 / span if span else None,
        "intervalMs": distribution(intervals),
        "intervalBuckets": buckets,
        "renderToPaintMs": distribution(
            int(row["render_to_paint_ns"]) / 1e6 for row in rows
        ),
        "nodeCount": distribution(row["node_count"] for row in rows),
        "distinctTreeRevisions": len({row["tree_revision"] for row in rows}),
    }


def batch_summary(records, window_id):
    rows = [
        row
        for row in records
        if row.get("type") == "batch_applied" and row.get("window_id") == window_id
    ]
    return {
        "batches": len(rows),
        "operations": distribution(row["operation_count"] for row in rows),
        "textBytes": distribution(row["text_bytes"] for row in rows),
        "preflightUs": distribution(row["preflight_nanos"] / 1000 for row in rows),
    }


def series_summary(samples, key):
    values = [sample[key] for sample in samples if sample.get(key) is not None]
    if not values:
        return None
    quarter = max(1, len(values) // 4)
    return {
        "samples": len(values),
        "first": values[0],
        "min": min(values),
        "max": max(values),
        "last": values[-1],
        "firstQuarterMedian": sorted(values[:quarter])[quarter // 2],
        "lastQuarterMedian": sorted(values[-quarter:])[quarter // 2],
    }


def process_sample(pid):
    status = Path(f"/proc/{pid}/status").read_text()
    fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
    return {
        "rssBytes": int(fields["VmRSS"].split()[0]) * 1024,
        "threads": int(fields["Threads"]),
        "fds": len(os.listdir(f"/proc/{pid}/fd")),
    }


def validate_application(result, framework):
    if result.get("status") != "passed" or result.get("framework") != framework:
        raise RuntimeError("Streaming fixture did not attest its framework")
    bounds = result["bounds"]
    if bounds["maxNodes"] > bounds["nodeBound"] or (
        bounds["maxListeners"] > bounds["listenerBound"]
    ):
        raise RuntimeError(
            "Native nodes or listeners exceeded the visible-window bound"
        )
    stream = result["stream"]
    if stream["ticks"] != result["fixture"]["ticks"]:
        raise RuntimeError("The deterministic stream did not complete")
    if stream["detachedStructuralChanges"] != 0 or stream["detachedTicks"] <= 0:
        raise RuntimeError("A detached view moved while streaming")
    return result


def baseline(reports):
    """Compact cross-adapter baseline. Every run must replay the same stream."""
    if not reports:
        raise RuntimeError("Summarize at least one passed soak report")
    digests = set()
    runs = []
    for report in reports:
        if report.get("status") != "passed":
            raise RuntimeError(f"Soak {report.get('scenario')} did not pass")
        application = report["application"]
        digests.add((application["fixture"]["version"], application["final"]["digest"]))
        frames = report["measurements"]["frames"]
        processes = report["measurements"]["processes"]
        runs.append(
            {
                "framework": report["framework"],
                "mode": report["mode"],
                "hostProfile": report["hostProfile"],
                "hostSha256": report["host"]["sha256"],
                "stream": {
                    key: application["stream"][key]
                    for key in (
                        "ticks",
                        "durationMs",
                        "commits",
                        "mutations",
                        "detachedTicks",
                        "detachedStructuralChanges",
                        "updateToAck",
                    )
                },
                "bounds": application["bounds"],
                "frames": {
                    key: frames[key]
                    for key in (
                        "frames",
                        "framesPerSecond",
                        "intervalMs",
                        "intervalBuckets",
                        "renderToPaintMs",
                        "nodeCount",
                    )
                },
                "batches": report["measurements"]["batches"],
                "processes": processes,
            }
        )
    if len(digests) != 1:
        raise RuntimeError(f"Soak runs replayed different streams: {sorted(digests)}")
    version, final_digest = digests.pop()
    return {
        "schemaVersion": 1,
        "fixtureVersion": version,
        "finalDigest": final_digest,
        "fixture": reports[0]["application"]["fixture"],
        "system": reports[0]["system"],
        "renderer": reports[0]["renderer"].get("gpu"),
        "runs": runs,
    }


def summarize(arguments):
    parser = argparse.ArgumentParser(prog="streaming-list.py summarize")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("reports", nargs="+", type=Path)
    args = parser.parse_args(arguments)
    summary = baseline([json.loads(path.read_text()) for path in args.reports])
    args.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"status": "passed", "runs": len(summary["runs"])}))
    return 0


def main():
    if sys.argv[1:2] == ["summarize"]:
        return summarize(sys.argv[2:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--framework", required=True, choices=sorted(FRAMEWORKS))
    parser.add_argument("--mode", required=True, choices=("development", "aot"))
    parser.add_argument("--host-profile", required=True, choices=("dev", "release"))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("Supply an explicit fixture command after --")
    if not DRIVER.proc_identity_matches():
        raise DRIVER.Unsupported("The current PID namespace does not match /proc")
    if not os.environ.get("DISPLAY"):
        raise DRIVER.Unsupported("A private X11 display is required")
    for tool in ("xdotool", "import", "convert"):
        if not shutil.which(tool):
            raise DRIVER.Unsupported(f"Required native soak tool unavailable: {tool}")
    host = Path(os.environ.get("BUN_NATIVE_HOST", ""))
    if not host.is_absolute() or not host.is_file():
        parser.error("BUN_NATIVE_HOST must identify an absolute prebuilt executable")
    host = host.resolve()
    framework = FRAMEWORKS[args.framework]
    scenario = f"{args.framework}-streaming-list"
    args.output.mkdir()
    output = args.output.resolve()
    nonce = secrets.token_hex(16)
    sources = {path: fingerprint(ROOT / path) for path in SOURCES}
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "scenario": scenario,
        "framework": framework,
        "mode": args.mode,
        "aot_verified_by_driver": False,
        "hostProfile": args.host_profile,
        "host": {"path": str(host), **fingerprint(host)},
        "system": {"platform": platform.platform(), "architecture": platform.machine()},
        "command": command,
        "sourceFiles": sources,
        "scope": "Actual GPUI child on isolated Xvfb/XTest with a software GPU. Frame records are native paint callbacks, not presentation timestamps; measurements are baselines, not thresholds.",
        "logs": {},
        "actions": [],
    }
    environment = {
        **os.environ,
        "BUN_NATIVE_DIAGNOSTICS_DIR": str(output),
        "BUN_NATIVE_DIAGNOSTICS_SCENARIO": scenario,
        "BUN_NATIVE_EVIDENCE_LOG": str(output / "native.jsonl"),
        "BUN_NATIVE_EVIDENCE_NONCE": nonce,
        "BUN_NATIVE_FRAME_TRACE": "1",
    }
    app = None
    observed = {}
    threads = []
    process_samples = []
    DRIVER.enable_subreaper()

    def interrupt(signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGALRM, signal.SIG_IGN)
        raise InterruptedError(f"Streaming soak received signal {signum}")

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGALRM, interrupt)
    signal.alarm(STREAM_TIMEOUT_SECONDS + 60)

    def sample():
        rows = DRIVER.owned_processes(app.pid, DRIVER.process_table())
        observed.update({row["pid"]: row["start_ticks"] for row in rows})
        return {row["pid"] for row in rows}

    def application_records():
        return DRIVER.read_events(output / "application.jsonl", nonce, 0)

    def native_records():
        return DRIVER.read_events(output / "native.jsonl", nonce, 0)

    def application_record(kind):
        return next(
            (row for row in application_records() if row.get("type") == kind), None
        )

    def wait_for(predicate, description, timeout=10.0, interval=0.02):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            sample()
            result = predicate()
            if result:
                return result
            if app.poll() is not None:
                raise RuntimeError(
                    f"Fixture exited {app.returncode} before {description}"
                )
            time.sleep(interval)
        raise RuntimeError(f"Timed out waiting for {description}")

    def owned_window(title):
        owned = sample()
        found = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", f"^{re.escape(title)}$"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        for candidate in found.stdout.split()[:16]:
            if not candidate.isdigit():
                continue
            try:
                owner = int(DRIVER.run(["xdotool", "getwindowpid", candidate]))
            except (RuntimeError, ValueError):
                continue
            if owner in owned and owner != app.pid:
                if Path(f"/proc/{owner}/exe").resolve() != host:
                    raise RuntimeError("Owned X11 PID is not the supplied native host")
                return candidate, owner
        return None

    try:
        app = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            start_new_session=True,
        )
        sample()
        for name, stream in (("stdout", app.stdout), ("stderr", app.stderr)):
            stats = {"written_bytes": 0, "discarded_bytes": 0}
            report["logs"][name] = stats
            thread = threading.Thread(
                target=DRIVER.capture,
                args=(stream, output / f"{name}.log", stats),
                daemon=True,
            )
            thread.start()
            threads.append(thread)
        mounted = wait_for(lambda: application_record("mounted"), "mounted list", 20)
        window, owner = wait_for(
            lambda: owned_window(f"Bun Native {framework} Streaming List"),
            "owned native window",
        )
        report["window"] = {"id": window, "hostPid": owner, "appPid": app.pid}
        renderer = wait_for(
            lambda: next(
                (row for row in native_records() if row.get("type") == "renderer"), None
            ),
            "actual renderer metadata",
        )
        if renderer.get("gpu", {}).get("is_software_emulated") is not True:
            raise RuntimeError(
                "The isolated soak requires the selected software renderer"
            )
        report["renderer"] = renderer
        window_id = renderer["window_id"]
        wait_for(
            lambda: any(
                row.get("type") == "frame"
                and row.get("window_id") == window_id
                and row.get("tree_revision", 0) >= mounted["treeRevision"]
                for row in native_records()
            ),
            "initial native frame",
        )
        DRIVER.run(["xdotool", "windowactivate", "--sync", window])

        def require_owned():
            row = DRIVER.process_table().get(owner)
            if row is None or observed.get(owner) != row["start_ticks"]:
                raise RuntimeError("Native host identity changed during the soak")
            if DRIVER.run(["xdotool", "getwindowfocus"]) != window:
                raise RuntimeError("The owned streaming window lost focus")

        def record_processes(phase):
            entry = {"at": time.monotonic(), "phase": phase}
            for role, pid in (("host", owner), ("application", app.pid)):
                try:
                    entry[role] = process_sample(pid)
                except (OSError, KeyError, ValueError):
                    entry[role] = None
            process_samples.append(entry)

        def pace(seconds, phase):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                record_processes(phase)
                if app.poll() is not None:
                    raise RuntimeError(
                        f"Fixture exited {app.returncode} during {phase}"
                    )
                time.sleep(PROCESS_SAMPLE_SECONDS)

        def navigation_count(key):
            return sum(
                1
                for row in application_records()
                if row.get("type") == "navigation" and row.get("key") == key
            )

        def key(name, keysym, phase):
            before = navigation_count(name)
            require_owned()
            DRIVER.run(["xdotool", "key", "--clearmodifiers", keysym])
            report["actions"].append(
                {"key": name, "phase": phase, "at": time.monotonic()}
            )
            wait_for(
                lambda: navigation_count(name) > before, f"native {name} navigation"
            )
            record_processes(phase)

        def pixel(name):
            DRIVER.run(["import", "-window", window, str(output / name)], timeout=5)
            value = DRIVER.run(
                ["convert", str(output / name), "-format", "%[hex:p{4,4}]", "info:"]
            )
            return value.lower()[:6]

        report["pixels"] = {"before": pixel("before.png")}
        if report["pixels"]["before"] != DARK_BACKGROUND:
            raise RuntimeError("The dark theme token did not reach native pixels")
        record_processes("idle")
        (output / "start").touch()
        wait_for(lambda: application_record("stream-start"), "stream start")
        pace(1.5, "following")
        for _ in range(3):
            key("up", "Up", "detach")
        pace(1.0, "detached")
        require_owned()
        DRIVER.run(
            [
                "xdotool",
                "mousemove",
                "--window",
                window,
                *map(str, ROW_CLICK),
                "click",
                "1",
            ]
        )
        report["actions"].append({"pointer": ROW_CLICK, "at": time.monotonic()})
        wait_for(lambda: application_record("pointer-selection"), "pointer selection")
        pace(0.5, "detached")
        key("f7", "F7", "theme")
        pace(0.3, "theme")
        report["pixels"]["light"] = pixel("light.png")
        if report["pixels"]["light"] != LIGHT_BACKGROUND:
            raise RuntimeError("The light theme token did not reach native pixels")
        key("f8", "F8", "density")
        key("pageup", "Page_Up", "navigate")
        key("home", "Home", "navigate")
        for _ in range(2):
            key("down", "Down", "navigate")
        pace(0.5, "detached")
        require_owned()
        for width, height in ((720, 480), (1180, 760)):
            DRIVER.run(
                ["xdotool", "windowsize", "--sync", window, str(width), str(height)]
            )
            report["actions"].append(
                {"resize": [width, height], "at": time.monotonic()}
            )
            pace(0.5, "resize")
        DRIVER.run(["xdotool", "windowactivate", "--sync", window])
        key("end", "End", "follow")
        until = time.monotonic() + STREAM_TIMEOUT_SECONDS
        while not application_record("stream-complete"):
            if time.monotonic() > until:
                raise RuntimeError("Timed out waiting for the complete stream")
            pace(0.25, "following")
        report["streamComplete"] = application_record("stream-complete")
        pace(0.5, "settled")
        report["pixels"]["after"] = pixel("after.png")
        if report["pixels"]["after"] != LIGHT_BACKGROUND:
            raise RuntimeError("The final native frame lost the selected theme")
        require_owned()
        DRIVER.run(["xdotool", "key", "--clearmodifiers", "alt+F4"])
        wait_for(lambda: app.poll() is not None, "fixture exit", 10)
        report["applicationExitCode"] = app.wait(timeout=1)
        if app.returncode != 0:
            raise RuntimeError(f"Streaming fixture exited {app.returncode}")
        application = output / "application-result.json"
        if application.stat().st_size > DRIVER.MAX_LOG_BYTES:
            raise RuntimeError("Streaming fixture result exceeded its evidence bound")
        report["application"] = validate_application(
            json.loads(application.read_text()), framework
        )
        records = native_records()
        if any(row.get("type") == "frame_limit" for row in records):
            raise RuntimeError("The bounded frame trace reached its record limit")
        if any(row.get("type") == "rendered" for row in records):
            raise RuntimeError("Frame tracing must suppress full-tree paint records")
        samples = application_records()
        report["measurements"] = {
            "frames": frame_summary(records, window_id),
            "batches": batch_summary(records, window_id),
            "applicationSamples": {
                key: series_summary(
                    [row for row in samples if row.get("type") == "sample"], key
                )
                for key in ("nodes", "listeners", "rssBytes", "heapUsedBytes")
            },
            "processes": {
                role: {
                    metric: series_summary(
                        [entry[role] for entry in process_samples if entry.get(role)],
                        metric,
                    )
                    for metric in ("rssBytes", "threads", "fds")
                }
                for role in ("host", "application")
            },
        }
        (output / "process-samples.json").write_text(
            json.dumps(process_samples, indent=1) + "\n"
        )
        if {
            path: fingerprint(ROOT / path) for path in SOURCES
        } != sources or fingerprint(host) != {
            key: report["host"][key] for key in ("sha256", "bytes")
        }:
            raise RuntimeError("Source or native artifact changed during the soak")
        report["status"] = "passed"
    except Exception as error:
        LOGGER.exception("Streaming soak failed")
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        signal.alarm(0)
        if app is not None:
            report["cleanup"] = DRIVER.cleanup(app, observed)
            if (
                report["cleanup"]["forced_termination"]
                or report["cleanup"]["remaining_observed_pids"]
                or report["cleanup"]["unreaped_observed_pids"]
            ):
                report["status"] = "failed"
        for thread in threads:
            thread.join(timeout=1)
        if any(thread.is_alive() for thread in threads) or any(
            stats["discarded_bytes"] for stats in report["logs"].values()
        ):
            report["status"] = "failed"
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "status": report["status"],
                "scenario": scenario,
                "mode": args.mode,
                "report": str(output / "result.json"),
                "error": report.get("error"),
            }
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
