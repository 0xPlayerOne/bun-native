"""Fixed native qualification of the actual checkout `native dev --watch` command.

One initial generation and 101 source-edit remounts per invocation. Native paint,
pointer evidence, process identity and cleanup reuse the existing Linux drivers.
These are observation intervals with diagnostic overhead, never presentation times.
"""

import argparse
import json
import math
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import cli_templates as TEMPLATES
from . import native_watch_processes as PROCESS
from .common import ROOT, interrupt_handler

DRIVER = PROCESS.DRIVER
EDIT_COUNT = 101
GENERATIONS = EDIT_COUNT + 1
GENERATION_SECONDS = 20
SESSION_SECONDS = 360


def configure(edits):
    """Sets the fixed edit count; the session budget scales from 360 s per 101 edits."""
    global EDIT_COUNT, GENERATIONS, SESSION_SECONDS
    EDIT_COUNT = edits
    GENERATIONS = edits + 1
    SESSION_SECONDS = max(360, -(-360 * edits // 101))


RESOURCE_KEYS = (
    "windows",
    "nodes",
    "callbacks",
    "queuedTransactions",
    "queuedCallbacks",
    "activeCallbacks",
    "serviceRequests",
)


def zero_teardown(value, pid):
    application = value.get("application") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or type(value.get("pid")) is not int
        or value["pid"] != pid
        or value.get("clean") is not True
        or type(value.get("nodes")) is not int
        or value["nodes"] != 0
        or not isinstance(application, dict)
        or any(
            type(application.get(key)) is not int or application[key] != 0
            for key in RESOURCE_KEYS
        )
    ):
        raise RuntimeError(
            "Missing, invalid or nonzero joined teardown acknowledgement"
        )


def paint(framework, token, count):
    expected = TEMPLATES.counter_paint(framework, count)
    expected["nodes"][3]["element"]["text"] = token
    return expected


def generation_source(original, framework, token):
    title = f"Bun Native {framework.title()}"
    if original.count(title) != 2 or not re.fullmatch(
        framework.title() + r" [0-9a-f]{8} [0-9]{3}", token
    ):
        raise RuntimeError("Expected the unchanged template heading and window title")
    return original.replace(title, token)


def validate_ready(value, index, previous, temporary_root):
    if (
        not isinstance(value, dict)
        or type(value.get("generation")) is not int
        or value["generation"] != index + 1
        or type(value.get("pid")) is not int
        or value["pid"] <= 1
    ):
        raise RuntimeError("Missing, duplicate or out-of-order watch generation")
    for key in ("bundleMs", "shutdownMs", "mountMs", "editToReadyMs"):
        if (
            type(value.get(key)) not in (int, float)
            or not math.isfinite(value[key])
            or value[key] < 0
        ):
            raise RuntimeError("Invalid watch observation duration")
    if previous is None:
        if "previous" in value:
            raise RuntimeError("Initial watch generation unexpectedly replaced an app")
    else:
        zero_teardown(value.get("previous"), previous["pid"])
    if not isinstance(value.get("bundle"), str):
        raise TypeError("Watch bundle must be an absolute owned file path")
    bundle = Path(value["bundle"])
    root = bundle.parent.parent
    if (
        not bundle.is_absolute()
        or bundle != bundle.resolve()
        or bundle.name != "application.js"
        or not bundle.parent.name.startswith("generation-")
        or not root.name.startswith("bun-native-dev-")
        or root.parent != Path(tempfile.gettempdir()).resolve()
        or not bundle.is_file()
        or (temporary_root is not None and root != temporary_root)
        or list(root.iterdir()) != [bundle.parent]
    ):
        raise RuntimeError(
            "Watch must own exactly one live generation in its OS temporary root"
        )
    return bundle, root


def records_after(path, nonce, observation):
    offset = observation["start_byte_offset"]
    if observation["ignored_preexisting_partial_record"]:
        with path.open("rb") as stream:
            stream.seek(offset)
            partial = stream.readline(DRIVER.PAINT_OBSERVER.MAX_RECORD_BYTES + 1)
        if len(partial) > DRIVER.PAINT_OBSERVER.MAX_RECORD_BYTES:
            raise RuntimeError("Native evidence partial record exceeded its bound")
        if not partial.endswith(b"\n"):
            return []
        offset += len(partial)
    return DRIVER.read_events(path, nonce, offset)


def malformed_diagnostic(path, offset, entry, framework):
    text = path.read_bytes()[offset:].decode(errors="replace")
    # Babel colors its code frame in CI. Ignore only SGR display codes while
    # preserving the fresh offset, error, source path and exact broken excerpt.
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    return (
        any(
            line in ("Bundle failed", f"{framework.title()} native build failed")
            for line in text.splitlines()
        )
        and str(entry) + ":" in text
        and "const incomplete = <" in text
    )


def sentinel(directory):
    directory.mkdir()
    log = directory / "invocations.log"
    log.touch()
    for tool in ("cargo", "rustc", "rustup"):
        path = directory / tool
        path.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$BUN_NATIVE_BUILD_SENTINEL"\nexit 97\n'
        )
        path.chmod(0o755)
    return log


interrupt = interrupt_handler("Native watch qualification")


def record_failure(report, error):
    report["status"] = "failed"
    if "error" in report:
        report.setdefault("secondary_errors", []).append(str(error))
    else:
        report["error"] = str(error)


def qualify(framework, output, host, bun):
    output.mkdir(parents=True, exist_ok=False)
    nonce = os.urandom(16).hex()
    native_log = output / "native.jsonl"
    native_log.touch()
    report = {
        "schema_version": 1,
        "status": "failed",
        "framework": framework,
        "language": "typescript",
        "nonce": nonce,
        "planned_source_edits": EDIT_COUNT,
        "planned_rejected_source_edits": 1,
        "planned_generations": GENERATIONS,
        "bounds": {
            "generation_observation_seconds": GENERATION_SECONDS,
            "session_seconds": SESSION_SECONDS,
            "os_close_seconds": 5,
            "cli_readiness_shutdown_seconds": 5,
        },
        "scope": "Actual CLI watch command, fresh app/host processes, XTest input and complete native paint; observation intervals include monitoring/logging overhead and are not display presentation or matched performance baselines",
        "platform": {
            "system": platform.platform(),
            "machine": platform.machine(),
            "display": os.environ.get("DISPLAY"),
        },
        "generations": [],
    }
    app = audit = stdout = stderr = None
    project_parent = temporary_root = build_log = None
    source_identity = host_identity = compiler_identity = None
    old_term = signal.signal(signal.SIGTERM, interrupt)
    old_alarm = signal.signal(signal.SIGALRM, interrupt)
    signal.alarm(SESSION_SECONDS)

    def check():
        if audit:
            audit.check()
        for capture in (stdout, stderr):
            if capture:
                capture.snapshot()
        if app is not None and app.poll() is not None:
            raise RuntimeError(f"Watch command exited unexpectedly ({app.returncode})")
        if build_log.stat().st_size:
            raise RuntimeError("An ordinary source edit invoked a Rust build tool")

    def wait_for(predicate, description, timeout=GENERATION_SECONDS):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            check()
            value = predicate()
            if value is not None and value is not False:
                return value
            time.sleep(0.01)
        raise TimeoutError(f"Timed out waiting for {description}")

    def ready_record(index):
        records = stdout.snapshot()
        if len(records) > index + 1:
            raise RuntimeError("Watch emitted an unrequested extra generation")
        if len(records) <= index:
            return None
        if records[index]["kind"] != "ready":
            raise RuntimeError("Watch stopped before all fixed source edits completed")
        return records[index]

    def owned_window(token, application):
        found = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", f"^{re.escape(token)}$"],
            capture_output=True,
            text=True,
            check=False,
            timeout=3,
        )
        for candidate in found.stdout.split()[:16]:
            if not candidate.isdigit():
                continue
            try:
                pid = int(DRIVER.run(["xdotool", "getwindowpid", candidate]))
            except (RuntimeError, ValueError):
                continue
            identity = audit.identity(pid, host, application)
            return candidate, identity
        return None

    def require_window(current):
        if audit.identity(current["app"]["pid"], bun) != current["app"]:
            raise RuntimeError("Ready app identity changed")
        if (
            audit.identity(current["host"]["pid"], host, current["app"])
            != current["host"]
        ):
            raise RuntimeError("Ready host identity changed")
        if DRIVER.run(["xdotool", "getwindowpid", current["window"]]) != str(
            current["host"]["pid"]
        ):
            raise RuntimeError("Native window changed its process owner")

    def focus(current):
        require_window(current)
        DRIVER.run(["xdotool", "windowactivate", "--sync", current["window"]])
        wait_for(
            lambda: DRIVER.run(["xdotool", "getwindowfocus"]) == current["window"],
            "owned window focus",
            timeout=3,
        )
        require_window(current)

    def click(current, count):
        focus(current)
        DRIVER.run(
            ["xdotool", "mousemove", "--window", current["window"], "100", "130"]
        )
        require_window(current)
        with DRIVER.PAINT_OBSERVER.PaintObserver(
            native_log,
            nonce,
            paint(framework, current["token"], count),
            timeout=GENERATION_SECONDS,
        ) as observer:
            observer.begin()
            DRIVER.run(["xdotool", "click", "1"])
            input_returned = time.monotonic_ns()
            observed = observer.result(input_returned)
            observed_ns = observer.observed["observed_ns"]
        events = records_after(native_log, nonce, observed)
        if not DRIVER.native_pointer_click_observed(events, 1, [100, 130]):
            raise RuntimeError(
                "Missing native down/up after the current generation's input offset"
            )
        require_window(current)
        return {
            "paint_observation": observed,
            "matching_paint_observed_ns": observed_ns,
            "native_pointer_down_up": True,
            "observer_joined": not observer.thread.is_alive()
            and not observer.descriptors,
        }

    def screenshot(current, name):
        require_window(current)
        path = output / name
        DRIVER.WINDOW_CAPTURE.capture_png(current["window"], path, timeout=3)
        report.setdefault("screenshots", {})[name] = TEMPLATES.artifact(path)

    try:
        if (
            sys.platform != "linux"
            or not os.environ.get("DISPLAY")
            or not DRIVER.proc_identity_matches()
        ):
            raise DRIVER.Unsupported(
                "A private Linux X11 display and matching /proc PID namespace are required"
            )
        missing = [tool for tool in ("xdotool",) if not shutil.which(tool)]
        if missing:
            raise DRIVER.Unsupported(f"Missing native input/capture tools: {missing}")
        DRIVER.enable_subreaper()
        source_identity = TEMPLATES.source_identity()
        host_identity = TEMPLATES.artifact(host)
        compiler_identity = TEMPLATES.artifact(bun)
        revision = (
            subprocess.check_output([str(bun), "--print", "Bun.revision"], timeout=10)
            .decode()
            .strip()
        )
        pin = json.loads((ROOT / "toolchain.json").read_text())
        if revision != pin["bun"]["revision"]:
            raise RuntimeError("Use the pinned Bun revision")
        report.update(
            source=source_identity,
            host={"path": str(host), "declared_profile": "release", **host_identity},
            compiler={"path": str(bun), "revision": revision, **compiler_identity},
            toolchain=pin,
        )
        build_log = sentinel(output / "no-native-build")
        environment = {
            **os.environ,
            "PATH": os.pathsep.join(
                [str(build_log.parent), str(bun.parent), os.environ.get("PATH", "")]
            ),
            "BUN_NATIVE_BUILD_SENTINEL": str(build_log),
            "BUN_NATIVE_EVIDENCE_LOG": str(native_log),
            "BUN_NATIVE_EVIDENCE_NONCE": nonce,
            "BUN_NATIVE_POINTER_TRACE": "1",
            "BUN_NATIVE_HOST_PROFILE": "release",
        }
        report["native_build_sentinel"] = {
            "tools": ["cargo", "rustc", "rustup"],
            "path": str(build_log.parent),
            "invocations": 0,
        }
        cache = ROOT / ".bun-native"
        cache.mkdir(exist_ok=True)
        project_parent = Path(tempfile.mkdtemp(prefix="native-watch-", dir=cache))
        project = project_parent / "app"
        create = [
            str(bun),
            "run",
            "native",
            "create",
            str(project),
            "--framework",
            framework,
            "--language",
            "typescript",
        ]
        with (output / "create.log").open("xb") as log:
            subprocess.run(
                create,
                cwd=ROOT,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
                timeout=15,
            )
        entry = project / "main.tsx"
        original = entry.read_text()
        shutil.copytree(project, output / "template")
        sources = output / "sources"
        sources.mkdir()
        command = [
            str(bun),
            "run",
            "native",
            "dev",
            str(project),
            "--host",
            str(host),
            "--watch",
        ]
        report.update(command=command, create_command=create, cwd=str(ROOT))
        previous = None
        current = None
        for index in range(GENERATIONS):
            report["active_generation"] = index + 1
            # Keep the heading on one line so each generation has the template's
            # original button geometry. The full nonce still guards every log.
            token = f"{framework.title()} {nonce[:8]} {index:03d}"
            source = generation_source(original, framework, token)
            (sources / f"generation-{index:03d}.tsx").write_text(source)
            if index == 0:
                entry.write_text(source)
            with DRIVER.PAINT_OBSERVER.PaintObserver(
                native_log,
                nonce,
                paint(framework, token, 0),
                timeout=GENERATION_SECONDS,
            ) as observer:
                trigger_ns = observer.begin()
                if index == 0:
                    app = subprocess.Popen(
                        command,
                        cwd=ROOT,
                        env=environment,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        start_new_session=True,
                    )
                    audit = PROCESS.ProcessAudit(app, host, bun, GENERATIONS)
                    stdout = PROCESS.Capture(
                        app.stdout,
                        output / "stdout.log",
                        record_limit=GENERATIONS + 1,
                        parse=True,
                    )
                    stderr = PROCESS.Capture(
                        app.stderr, output / "stderr.log", record_limit=GENERATIONS + 1
                    )
                else:
                    entry.write_text(source)
                trigger_completed = time.monotonic_ns()
                ready = wait_for(
                    lambda index=index: ready_record(index),
                    f"generation {index + 1} readiness",
                )
                bundle, temporary_root = validate_ready(
                    ready["value"],
                    index,
                    previous["app"] if previous else None,
                    temporary_root,
                )
                application = audit.identity(ready["value"]["pid"], bun)
                if index == 0:
                    audit.bind_controllers(application["pid"])
                if previous:
                    PROCESS.require_absent(
                        DRIVER.process_table(), [previous["app"], previous["host"]]
                    )
                    if previous["bundle"].exists():
                        raise RuntimeError(
                            "Old generation bundle still exists after joined replacement"
                        )
                window, native = wait_for(
                    lambda token=token, application=application: owned_window(
                        token, application
                    ),
                    "current generation's owned native window",
                )
                initial = observer.result(trigger_completed)
                initial_observed_ns = observer.observed["observed_ns"]
            initial["start"] = (
                "immediately before initial CLI launch"
                if index == 0
                else "immediately before writing the source edit"
            )
            initial["scope"] = (
                "launch/edit to complete native paint-record observation; includes build, shutdown, process startup, scheduling and log I/O; not presentation"
            )
            initial["trigger_start_to_paint_observed_ms"] = initial.pop(
                "command_start_to_paint_observed_ms"
            )
            initial["trigger_start_to_command_returned_ms"] = initial.pop(
                "command_start_to_input_commands_returned_ms"
            )
            initial["observed_before_command_returned"] = initial.pop(
                "observed_before_input_commands_returned"
            )
            events = records_after(native_log, nonce, initial)
            renderers = [
                event.get("gpu") for event in events if event.get("type") == "renderer"
            ]
            if (
                not renderers
                or not isinstance(renderers[-1], dict)
                or renderers[-1].get("is_software_emulated") is not True
                or not all(
                    isinstance(renderers[-1].get(key), str) and renderers[-1][key]
                    for key in ("device_name", "driver_name", "driver_info")
                )
            ):
                raise RuntimeError(
                    "Current native host did not report the selected software renderer"
                )
            current = {
                "app": application,
                "host": native,
                "window": window,
                "token": token,
                "bundle": bundle,
            }
            row = {
                "index": index,
                "source_token": token,
                "source": TEMPLATES.artifact(entry),
                "trigger": "initial-command-launch"
                if index == 0
                else "source-file-edit",
                "trigger_ns": trigger_ns,
                "trigger_completed_ns": trigger_completed,
                "ready": ready,
                "app": application,
                "host": native,
                "window": window,
                "bundle": {"path": str(bundle), **TEMPLATES.artifact(bundle)},
                "temporary_root": str(temporary_root),
                "live_generation_directories": 1,
                "previous_app_and_host_absent": previous is not None,
                "initial_paint": initial,
                "initial_paint_observed_ns": initial_observed_ns,
                "renderer": renderers[-1],
                "complete": False,
                "trigger_to_ready_record_observed_ms": (
                    ready["observed_ns"] - trigger_ns
                )
                / 1_000_000,
                "trigger_to_initial_paint_observed_ms": (
                    initial_observed_ns - trigger_ns
                )
                / 1_000_000,
                "initial_observer_joined": not observer.thread.is_alive()
                and not observer.descriptors,
            }
            report["generations"].append(row)
            if index in (0, EDIT_COUNT):
                screenshot(current, f"generation-{index:03d}-before.png")
            row["input"] = click(current, 1)
            TEMPLATES.require_artifact(bundle, row["bundle"])
            row["process_snapshot"] = audit.resource_snapshot(application, native)
            row["trigger_to_input_confirmed_paint_observed_ms"] = (
                row["input"]["matching_paint_observed_ns"] - trigger_ns
            ) / 1_000_000
            row["complete"] = True
            if index in (0, EDIT_COUNT):
                screenshot(current, f"generation-{index:03d}-after.png")
            if index == 0:
                offset = (output / "stderr.log").stat().st_size
                broken = "const incomplete = <\n"
                (sources / "malformed.tsx").write_text(broken)
                entry.write_text(broken)
                wait_for(
                    lambda offset=offset: malformed_diagnostic(
                        output / "stderr.log", offset, entry, framework
                    ),
                    "malformed-edit error",
                )
                if len(stdout.snapshot()) != 1 or TEMPLATES.artifact(bundle) != {
                    key: row["bundle"][key] for key in ("bytes", "sha256")
                }:
                    raise RuntimeError(
                        "Malformed edit replaced the working app or its bundle"
                    )
                preserved = click(current, 2)
                if len(stdout.snapshot()) != 1 or list(temporary_root.iterdir()) != [
                    bundle.parent
                ]:
                    raise RuntimeError("Malformed edit changed generation ownership")
                report["malformed_edit"] = {
                    "working_app_preserved": True,
                    "app": application,
                    "host": native,
                    "source": TEMPLATES.artifact(entry),
                    "stderr_start_offset": offset,
                    "responsive_counter_two": preserved,
                }
            check()
            if len(stdout.snapshot()) != index + 1:
                raise RuntimeError(
                    "Watch emitted an extra generation without a source edit"
                )
            previous = current
        focus(current)
        close_started = time.monotonic_ns()
        DRIVER.run(["xdotool", "key", "--clearmodifiers", "alt+F4"])
        app.wait(timeout=5)
        for capture in (stdout, stderr):
            capture.thread.join(timeout=1)
            if capture.thread.is_alive():
                raise RuntimeError("Watch log pipe did not close")
        records = stdout.snapshot()
        if (
            app.returncode != 0
            or len(records) != GENERATIONS + 1
            or records[-1]["kind"] != "stopped"
        ):
            raise RuntimeError("OS close did not produce a successful final watch exit")
        zero_teardown(records[-1]["value"], current["app"]["pid"])
        PROCESS.require_absent(
            DRIVER.process_table(), [current["app"], current["host"]]
        )
        if temporary_root.exists():
            raise RuntimeError("Watch left its owned temporary root after OS close")
        if build_log.stat().st_size:
            raise RuntimeError("Watch invoked a Rust build tool")
        audit.check()
        if audit.max_hosts != 1 or audit.max_apps != 1:
            raise RuntimeError(
                "Process monitor did not observe exactly one live app and native host"
            )
        report["final_close"] = {
            "method": "XTest Alt+F4",
            "requested_ns": close_started,
            "exit_observed_ns": time.monotonic_ns(),
            "exit_code": app.returncode,
            "stopped": records[-1],
            "app_and_host_absent": True,
            "temporary_root_removed": True,
        }
        report["status"] = "passed"
    except DRIVER.Unsupported as error:
        report.update(status="unsupported", error=str(error))
    except (
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
    ) as error:
        record_failure(report, error)
    finally:
        signal.alarm(0)
        if build_log is not None:
            report["native_build_sentinel"]["invocations"] = len(
                build_log.read_bytes().splitlines()
            )
            if report["native_build_sentinel"]["invocations"]:
                record_failure(report, "Watch invoked a Rust build tool")
        if audit:
            audit.finished.set()
            audit.thread.join(timeout=1)
            if audit.thread.is_alive() or audit.error:
                record_failure(report, audit.error or "Process audit did not join")
            report["process_audit"] = {
                "sample_interval_ms": 10,
                "scope": "Observed overlap plus CLI-enforced joined transitions; sampling alone cannot prove absence between samples",
                "maximum_live_native_hosts": audit.max_hosts,
                "maximum_live_application_processes": audit.max_apps,
                "sampled_peak_tree_rss_bytes": audit.peak_rss,
                "changes": audit.changes,
                "observed_identities": audit.snapshot(),
            }
        if app:
            cleanup = (
                DRIVER.cleanup(app, audit.snapshot())
                if audit
                else PROCESS.join_unobserved_child(app)
            )
            report["cleanup"] = cleanup
            if not audit:
                record_failure(
                    report,
                    "Process audit did not initialize; descendant cleanup is unverified",
                )
            if (
                cleanup["forced_termination"]
                or cleanup["remaining_observed_pids"]
                or cleanup["unreaped_observed_pids"]
                or cleanup.get("direct_child_joined") is False
            ):
                record_failure(
                    report,
                    "Watch process tree required forced cleanup or retained owners",
                )
            for capture in (stdout, stderr):
                if capture:
                    capture.thread.join(timeout=1)
                    if capture.thread.is_alive() or capture.error:
                        record_failure(
                            report, capture.error or "Watch log reader did not join"
                        )
                    report.setdefault("logs", {})[capture.path.name] = {
                        "written_bytes": capture.written,
                        "discarded_bytes": capture.discarded,
                    }
            app.stdout.close()
            app.stderr.close()
        try:
            if host_identity is not None:
                TEMPLATES.require_artifact(host, host_identity)
                TEMPLATES.require_artifact(bun, compiler_identity)
                if TEMPLATES.source_identity() != source_identity:
                    raise RuntimeError(
                        "Qualification source changed during the watch experiment"
                    )
                report["host_compiler_source_unchanged"] = True
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            record_failure(report, error)
        cleanup = report.get("cleanup", {})
        if (
            project_parent
            and not cleanup.get("remaining_observed_pids")
            and cleanup.get("direct_child_joined") is not False
        ):
            shutil.rmtree(project_parent)
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGALRM, old_alarm)
        print(
            json.dumps(
                {"status": report["status"], "evidence": str(output / "result.json")}
            )
        )
    return (
        0
        if report["status"] == "passed"
        else 2
        if report["status"] == "unsupported"
        else 1
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--framework", choices=("solid", "react"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--host", type=Path, required=True)
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument(
        "--edits",
        type=int,
        default=EDIT_COUNT,
        help="source-edit remounts after the initial generation (sustained memory runs, #372)",
    )
    args = parser.parse_args()
    if args.edits < 1:
        parser.error("--edits must be at least 1")
    configure(args.edits)
    return qualify(
        args.framework,
        args.output.resolve(),
        args.host.resolve(strict=True),
        args.bun.resolve(strict=True),
    )
