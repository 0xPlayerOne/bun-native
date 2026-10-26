"""Bounded process-tree observation. psutil is a contributor-only dependency.
RSS sums may double-count shared pages. Context switches are NOT kernel wakeups.
Only descendants observed with their creation time are eligible for cleanup.
"""

import argparse
import json
import math
import os
import platform
import signal
import subprocess
import sys
import threading
import time
from contextlib import suppress
from pathlib import Path

import psutil

# runpy/importlib callers do not necessarily place this file's directory on
# sys.path. Resolve our own trusted siblings independently of the launch cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))

OUTPUT_LIMIT = 2 * 1024 * 1024

# Keep whole-run native qualification receipts independently of noisy log tails.
# Duplicates remain duplicates; overflow fails rather than evicting evidence.
NATIVE_DIAGNOSTIC_COUNT = 128
NATIVE_DIAGNOSTIC_BYTES = 64 * 1024
NATIVE_DIAGNOSTIC_LINE_BYTES = 16 * 1024
NATIVE_DIAGNOSTIC_EVENTS = frozenset(
    json.loads(
        (
            Path(__file__).resolve().parents[1] / "benchmarks/lib/native-diagnostic-events.json"
        ).read_text(encoding="utf-8")
    )
)


def phase_marker(item, stdout):
    """Diagnostics only: native transport fixtures have no protocol stdout.

    Stderr accepts one exact versioned marker and three fixed phase names. It
    cannot supply native success, process ownership, or authority evidence.
    """
    if not isinstance(item, dict):
        return None
    if stdout and item.get("event") == "phase":
        return str(item.get("phase", "unknown"))
    if (
        not stdout
        and set(item) == {"event", "schema", "phase"}
        and item.get("event") == "bunly.transport.phase"
        and type(item.get("schema")) is int
        and item["schema"] == 1
        and item.get("phase") in ("transport-idle", "transport-work", "transport-complete")
    ):
        return item["phase"]
    if (
        not stdout
        and set(item) == {"event", "schema", "phase"}
        and item.get("event") == "bunly.terminal-load.phase"
        and type(item.get("schema")) is int
        and item["schema"] == 1
        and item.get("phase") in ("warmup", "ramp", "sustained", "recovery")
    ):
        return item["phase"]
    return None


def owned_process(identity):
    """Use a fresh kernel identity; cached Process objects may refer to a reused PID."""
    try:
        current = psutil.Process(identity[0])
        if (
            current.create_time() == identity[1]
            and current.is_running()
            and current.status() != psutil.STATUS_ZOMBIE
        ):
            return current
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return None


def kill_owned(identity):
    current = owned_process(identity)
    if current is not None:
        with suppress(psutil.Error):
            current.kill()


def post_exit_resources(samples):
    selected = [sample for sample in samples if sample["phase"] == "post-exit-cleanup"]
    cpu_seconds = 0.0
    matched = 0
    for previous, current in zip(selected, selected[1:], strict=False):
        old = {(row["pid"], row["creationTime"]): row for row in previous["processes"]}
        for row in current["processes"]:
            before = old.get((row["pid"], row["creationTime"]))
            if before is not None and row["cpuSeconds"] >= before["cpuSeconds"]:
                cpu_seconds += row["cpuSeconds"] - before["cpuSeconds"]
                matched += 1
    return {
        "sampleCount": len(selected),
        "peakRssBytes": max((sample["rssBytes"] for sample in selected), default=None),
        "peakThreads": max((sample["threads"] for sample in selected), default=None),
        "sampledCpuSeconds": cpu_seconds if matched else None,
        "accounting": "post-exit samples; adjacent same-PID/birth CPU deltas; gaps and exits are not zero CPU",
    }


def observe(
    command,
    timeout=30.0,
    interval=0.025,
    max_samples=4000,
    counter_reader=None,
    stop_event=None,
    sandbox_reader=None,
    cleanup_observer=None,
    phase_observer=None,
):
    if (
        not command
        or not math.isfinite(timeout)
        or not math.isfinite(interval)
        or timeout <= 0
        or interval < 0.01
        or max_samples < 1
    ):
        raise ValueError("Invalid bounded observation options")
    clone_cleanup = None
    if sys.platform == "darwin":
        from macos_clone_cleanup import for_command

        clone_cleanup = for_command(command)
    started = time.monotonic()
    child = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=os.name != "nt",
    )
    try:
        root = psutil.Process(child.pid)
        root_identity = (root.pid, root.create_time())
        known = {root_identity: root}
    except psutil.NoSuchProcess:
        root, root_identity, known = None, None, {}
    if clone_cleanup is not None:
        clone_cleanup.bind(root)
    lines, errors, samples, event_times, native_diagnostics = [], [], [], [], []
    native_diagnostic_bytes = 0
    # Optional notifications share the admitted native receipt bounds. They are
    # delivered on the observing thread, never while holding the pipe-reader lock.
    phase_notifications = [] if phase_observer is not None else None
    state = {"phase": "startup", "bytes": 0, "overflow": False, "observerFailure": None}
    lock = threading.Lock()

    def drain(stream, output, phases=False):
        nonlocal native_diagnostic_bytes
        for raw in iter(lambda: stream.readline(OUTPUT_LIMIT + 1), b""):
            received = time.monotonic()
            with lock:
                state["bytes"] += len(raw)
                if state["bytes"] > OUTPUT_LIMIT:
                    state["overflow"] = True
                    continue
                text = raw.decode("utf-8", errors="replace").rstrip()
                output.append(text)
                try:
                    item = json.loads(text)
                    if isinstance(item, dict):
                        if (
                            not phases
                            and isinstance(item.get("event"), str)
                            and item["event"] in NATIVE_DIAGNOSTIC_EVENTS
                        ):
                            encoded_bytes = len(text.encode("utf-8"))
                            if (
                                len(native_diagnostics) >= NATIVE_DIAGNOSTIC_COUNT
                                or encoded_bytes > NATIVE_DIAGNOSTIC_LINE_BYTES
                                or native_diagnostic_bytes + encoded_bytes > NATIVE_DIAGNOSTIC_BYTES
                            ):
                                state["overflow"] = True
                            else:
                                native_diagnostics.append(text)
                                native_diagnostic_bytes += encoded_bytes
                                if (
                                    phase_notifications is not None
                                    and item["event"] == "bunly.host.shutdown-phase"
                                ):
                                    phase_notifications.append((item, received))
                        marked = phase_marker(item, phases)
                        if marked is not None:
                            state["phase"] = marked
                        # One allowlisted receipt timestamp supports startup
                        # profiling. No payload, identity or authority is taken
                        # from this optional diagnostic event.
                        if (
                            not phases
                            and not event_times
                            and item.get("event") == "bunly.foundation.ready"
                        ):
                            event_times.append(
                                {
                                    "event": "bunly.foundation.ready",
                                    "elapsedMs": (received - started) * 1000,
                                    "stream": "stderr",
                                }
                            )
                except (ValueError, RecursionError):
                    pass
        stream.close()

    readers = [
        threading.Thread(target=drain, args=(child.stdout, lines, True), daemon=True),
        threading.Thread(target=drain, args=(child.stderr, errors), daemon=True),
    ]
    for reader in readers:
        reader.start()

    def alive(identity, proc):
        return owned_process(identity) is not None

    def deliver_phase_notifications():
        if phase_notifications is None:
            return
        with lock:
            pending = phase_notifications[:]
            phase_notifications.clear()
        for item, received in pending:
            if state["observerFailure"] is not None:
                break
            try:
                phase_observer(item, received)
            except Exception:
                state["observerFailure"] = "phase-observer-failed"

    def snapshot(phase_override=None):
        deliver_phase_notifications()
        try:
            current_root = owned_process(root_identity) if root_identity is not None else None
            if current_root is not None:
                descendants = current_root.children(recursive=True)
                # Revalidate before admitting newly discovered descendants.
                if owned_process(root_identity) is None:
                    descendants = []
                for proc in descendants:
                    known[(proc.pid, proc.create_time())] = proc
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        if clone_cleanup is not None:
            clone_cleanup.discover_clones()
            for identity, proc in list(known.items()):
                if identity[0] != child.pid:
                    clone_cleanup.remember(identity, proc)
            if cleanup_observer is not None:
                try:
                    cleanup_observer(clone_cleanup)
                except Exception:
                    # A qualification callback cannot strand suspended/owned
                    # children by escaping the normal bounded cleanup path.
                    state["observerFailure"] = "cleanup-observer-failed"
        rows = []
        for identity, proc in list(known.items()):
            if not alive(identity, proc):
                continue
            try:
                with proc.oneshot():
                    cpu = proc.cpu_times()
                    row = {
                        "pid": identity[0],
                        "creationTime": identity[1],
                        "rssBytes": proc.memory_info().rss,
                        "threads": proc.num_threads(),
                        "cpuSeconds": cpu.user + cpu.system,
                    }
                    try:
                        switches = proc.num_ctx_switches()
                        row["contextSwitches"] = switches.voluntary + switches.involuntary
                    except (psutil.Error, AttributeError, NotImplementedError):
                        row["contextSwitches"] = None
                    try:
                        row["descriptors"] = (
                            proc.num_fds() if os.name != "nt" else proc.num_handles()
                        )
                    except (psutil.Error, AttributeError, NotImplementedError):
                        row["descriptors"] = None
                if counter_reader is not None:
                    row["kernelCounters"] = counter_reader(identity[0])
                if sandbox_reader is not None:
                    field = {"linux": "linuxSandbox", "win32": "windowsSandbox"}.get(
                        sys.platform, "seatbelt"
                    )
                    roles = {
                        "renderer",
                        "gpu-process",
                        "utility",
                        "zygote",
                        "crashpad-handler",
                        "code-sign-clone-cleanup",
                    }
                    row["browserRole"] = None
                    try:
                        for arg in proc.cmdline():
                            if arg.startswith("--type=") and arg[7:] in roles:
                                row["browserRole"] = arg[7:]
                                break
                        row[field] = sandbox_reader(identity[0])
                    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                        row[field] = {
                            "provider": {
                                "linux": "linux-proc-status-v1",
                                "win32": "windows-token-job-v1",
                            }.get(sys.platform, "macos-seatbelt-presence"),
                            "active": None,
                            "available": False,
                            "isolationObserved": None,
                            "error": "unavailable",
                        }
                if alive(identity, proc):
                    rows.append(row)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        with lock:
            phase = state["phase"]
        return {
            "elapsedMs": (time.monotonic() - started) * 1000,
            "phase": phase_override or phase,
            "processes": rows,
            "rssBytes": sum(row["rssBytes"] for row in rows),
            "threads": sum(row["threads"] for row in rows),
        }

    timed_out = False
    cancelled = False
    # Keep room for the bounded post-exit window while continuing identity
    # discovery even when the ordinary sample budget is exhausted.
    reserve = min(max_samples, int(3.0 / interval) + 2) if clone_cleanup is not None else 0
    while child.poll() is None:
        if stop_event is not None and stop_event.is_set():
            cancelled = True
            break
        sample = snapshot()
        if len(samples) < max_samples - reserve:
            samples.append(sample)
        if state["observerFailure"] is not None:
            cancelled = True
            break
        if time.monotonic() - started > timeout or state["overflow"]:
            timed_out = True
            break
        time.sleep(interval)
    if timed_out or cancelled:
        # Discover still-owned descendants once more before interrupting the
        # root. This is bounded sampling, not a claim of kernel process tracking.
        if len(samples) < max_samples:
            samples.append(snapshot())
        else:
            snapshot()
        for identity, _proc in reversed(list(known.items())):
            kill_owned(identity)
        child.kill()
    try:
        code = child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        code = child.wait(timeout=5)
    root_exit = time.monotonic()
    grace = root_exit + 0.5
    if not timed_out and not cancelled and cleanup_observer is not None:
        on_root_exit = getattr(cleanup_observer, "on_root_exit", None)
        if on_root_exit is not None:
            try:
                # Diagnostic fault controls may act only after wait() has
                # completed the root's exit/reparenting transition.
                on_root_exit(root_exit)
            except Exception:
                state["observerFailure"] = "cleanup-observer-failed"
                cancelled = True
    if clone_cleanup is not None and not timed_out and not cancelled:
        clone_cleanup.discover_clones()
        for identity, proc in clone_cleanup.recover_after_exit():
            known[identity] = proc
        # Always take one post-exit observation, including a cleanup child that
        # reparented between the last descendant sample and root exit.
        sample = snapshot("post-exit-cleanup")
        if len(samples) < max_samples:
            samples.append(sample)
        if state["observerFailure"] is not None:
            cancelled = True
    while time.monotonic() < grace and any(
        identity[0] != child.pid and alive(identity, proc) for identity, proc in known.items()
    ):
        if clone_cleanup is not None and len(samples) < max_samples:
            samples.append(snapshot("post-exit-cleanup"))
        if state["observerFailure"] is not None:
            cancelled = True
            break
        time.sleep(interval)
    survivors = [
        identity[0]
        for identity, proc in known.items()
        if identity[0] != child.pid and alive(identity, proc)
    ]
    orphan_details = []
    for identity, proc in known.items():
        if identity[0] not in survivors or not alive(identity, proc):
            continue
        detail = {
            "pid": identity[0],
            "creationTime": identity[1],
            "name": None,
            "parentPid": None,
            "browserRole": None,
        }
        try:
            detail["name"] = proc.name()[:256]
            detail["parentPid"] = proc.ppid()
            # Only retain an allowlisted browser role, never the full command
            # line (which may contain URLs, paths or application credentials).
            roles = {
                "renderer",
                "gpu-process",
                "utility",
                "zygote",
                "crashpad-handler",
                "code-sign-clone-cleanup",
            }
            for arg in proc.cmdline():
                if arg.startswith("--type=") and arg[7:] in roles:
                    detail["browserRole"] = arg[7:]
                    break
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            detail["identityDetailsUnavailable"] = True
        orphan_details.append(detail)
    post_exit = None
    if clone_cleanup is not None and not timed_out and not cancelled:
        # Ordinary descendants are judged at 500 ms, even if they exit during the
        # separate proven-cleanup window. No role-only blanket exception.
        eligible = {identity for identity in clone_cleanup.helpers if clone_cleanup.grant(identity)}
        for identity, proc in known.items():
            if identity[0] in survivors and identity not in eligible and alive(identity, proc):
                kill_owned(identity)
        deadline = root_exit + 3.0
        while eligible and time.monotonic() < deadline:
            if all(clone_cleanup.complete(identity) for identity in eligible):
                break
            if (stop_event is not None and stop_event.is_set()) or state["observerFailure"]:
                cancelled = True
                break
            if any(clone_cleanup.state(identity) == "invalid" for identity in eligible):
                break
            if len(samples) < max_samples:
                samples.append(snapshot("post-exit-cleanup"))
            time.sleep(interval)
        within_deadline = time.monotonic() <= deadline
        completed = {
            identity[0]
            for identity in eligible
            if within_deadline and clone_cleanup.complete(identity)
        }
        survivors = [pid for pid in survivors if pid not in completed]
        orphan_details = [row for row in orphan_details if row["pid"] not in completed]
        post_exit = clone_cleanup.report((time.monotonic() - root_exit) * 1000)
        post_exit["resources"] = post_exit_resources(samples)
        if eligible and not within_deadline:
            post_exit["passed"] = False
            post_exit["qualified"] = False
            post_exit["status"] = "failed"
    if clone_cleanup is not None and (timed_out or cancelled):
        # Interruption does not attest clone removal, even if owned processes
        # were killed successfully. Preserve the evidence and retain the fixture.
        post_exit = clone_cleanup.report((time.monotonic() - root_exit) * 1000)
        post_exit["resources"] = post_exit_resources(samples)
        post_exit["passed"] = False
        post_exit["qualified"] = False
        post_exit["status"] = "failed"
    for identity, proc in known.items():
        if identity[0] in survivors and alive(identity, proc):
            kill_owned(identity)
    cleanup_deadline = time.monotonic() + 1
    while time.monotonic() < cleanup_deadline and any(
        alive(identity, proc) for identity, proc in known.items()
    ):
        time.sleep(interval)
    cleanup_survivors = [identity[0] for identity, proc in known.items() if alive(identity, proc)]
    for reader in readers:
        reader.join(timeout=2)
    # Retain completion receipts from a process that exited between snapshots.
    # Delivery here does not start another sample or grant post-exit ownership.
    deliver_phase_notifications()
    reports = []
    for line in lines:
        try:
            value = json.loads(line)
            if isinstance(value, dict) and value.get("event") != "phase":
                reports.append(value)
        except ValueError:
            pass
    return {
        "schema": 1,
        **({"postExitCleanup": post_exit} if post_exit is not None else {}),
        "exitCode": code,
        "eventTimes": event_times,
        "observerFailure": state["observerFailure"],
        "timedOut": timed_out,
        "cancelled": cancelled,
        "cleanupSurvivors": cleanup_survivors,
        "outputOverflow": state["overflow"],
        "elapsedMs": (time.monotonic() - started) * 1000,
        "samples": samples,
        "reports": reports,
        "stdoutTail": lines[-40:],
        "stderr": errors[-20:],
        "nativeDiagnostics": native_diagnostics,
        "observedOrphans": survivors,
        "orphanDetails": orphan_details,
        "observedProcesses": len(known),
        "peakTreeRssBytes": max((s["rssBytes"] for s in samples), default=0),
        "peakTreeThreads": max((s["threads"] for s in samples), default=0),
        "accounting": {
            "intervalMs": interval * 1000,
            "sampleCap": max_samples,
            "exitGraceMs": 500,
            "rss": "sum of observed resident sets; shared pages may be counted more than once",
            "descriptors": "handles on Windows; file descriptors on POSIX",
            "wakeups": None,
            "wakeupsUnavailable": "No generic portable wakeup value; optional provider-specific counters are separate",
            "coverage": "sampling can miss very short-lived descendants; known survivors are failures even if cleanup succeeds",
        },
        "environment": {
            "os": platform.system(),
            "release": platform.release(),
            "arch": platform.machine(),
            "logicalCpus": psutil.cpu_count(),
            "memoryBytes": psutil.virtual_memory().total,
            "psutil": psutil.__version__,
            "python": platform.python_version(),
            "runClass": "ci-smoke" if os.getenv("CI") else "local-smoke",
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--observation-id")
    parser.add_argument("--control-id")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    if options.observation_id is not None and (
        len(options.observation_id) != 48
        or any(char not in "0123456789abcdef" for char in options.observation_id)
    ):
        parser.error("Invalid observation identity")
    if options.control_id is not None and options.control_id != options.observation_id:
        parser.error("Control identity must match the observation identity")
    command = options.command[1:] if options.command[:1] == ["--"] else options.command
    stop_event = threading.Event()
    signal.signal(signal.SIGTERM, lambda _number, _frame: stop_event.set())
    signal.signal(signal.SIGINT, lambda _number, _frame: stop_event.set())
    if options.control_id is not None:
        # Read the private parent pipe without holding sys.stdin's buffered lock
        # during interpreter shutdown. Input sent before startup remains buffered.
        def control():
            packet = bytearray()
            try:
                while len(packet) <= 128 and b"\n" not in packet:
                    part = os.read(0, 128 - len(packet) + 1)
                    if not part:
                        # Losing the controlling parent also requests cleanup.
                        stop_event.set()
                        return
                    packet.extend(part)
                if bytes(packet) == ("cancel " + options.control_id + "\n").encode("ascii"):
                    stop_event.set()
                else:
                    # Malformed private control input must never leave work running.
                    stop_event.set()
            except OSError:
                stop_event.set()

        threading.Thread(target=control, daemon=True).start()
    sandbox_reader = None
    if os.getenv("BUNLY_BENCH_SANDBOX") == "1":
        if sys.platform == "linux":
            from linux_sandbox import presence
        elif sys.platform == "win32":
            from windows_sandbox import presence
        else:
            from macos_sandbox import presence
        sandbox_reader = presence
    counter_reader = None
    if os.getenv("BUNLY_KERNEL_COUNTERS") == "1":
        from kernel_counters import sample_counters

        counter_reader = sample_counters
    result = observe(
        command,
        options.timeout,
        stop_event=stop_event,
        sandbox_reader=sandbox_reader,
        counter_reader=counter_reader,
    )
    if counter_reader is not None:
        from kernel_counters import summarize_counters

        result["kernelMeasurements"] = summarize_counters(result["samples"])
    if options.observation_id is not None:
        result["observationId"] = options.observation_id
    destination = Path(options.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                key: result[key]
                for key in (
                    "exitCode",
                    "timedOut",
                    "observedOrphans",
                    "orphanDetails",
                    "observedProcesses",
                    "peakTreeRssBytes",
                    "peakTreeThreads",
                )
            }
        )
    )
    raise SystemExit(
        1
        if result["timedOut"]
        or result["cancelled"]
        or result["outputOverflow"]
        or result["observedOrphans"]
        or result["cleanupSurvivors"]
        or result.get("postExitCleanup", {}).get("passed") is False
        else 0
    )
