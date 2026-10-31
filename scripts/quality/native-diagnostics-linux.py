#!/usr/bin/env python3
"""Bounded actual-host startup, failure-containment and scheduling diagnostics.

Run only inside the repository's isolated Xvfb/DBus session. Process discovery,
window ownership, nonce/log bounds and cleanup reuse the native input driver.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_input_linux", ROOT / "scripts/quality/native-input-linux.py"
)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)
LAYOUT_SPEC = importlib.util.spec_from_file_location(
    "native_layout_scenario", ROOT / "scripts/quality/native-layout-scenario.py"
)
LAYOUT = importlib.util.module_from_spec(LAYOUT_SPEC)
LAYOUT_SPEC.loader.exec_module(LAYOUT)
INTERACTIONS_SPEC = importlib.util.spec_from_file_location(
    "native_interactions_scenario",
    ROOT / "scripts/quality/native-interactions-scenario.py",
)
INTERACTIONS = importlib.util.module_from_spec(INTERACTIONS_SPEC)
INTERACTIONS_SPEC.loader.exec_module(INTERACTIONS)
SCENARIOS = (
    "startup-failure",
    "host-crash",
    "scheduling",
    "scheduling-control",
    "layout",
    "interactions",
)


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "bytes": path.stat().st_size}


def source_snapshot():
    paths = [
        ROOT / "tests/native/fault.ts",
        ROOT / "tests/native/scheduling.ts",
        ROOT / "tests/native/layout.ts",
        ROOT / "tests/native/interactions.ts",
        ROOT / "scripts/quality/native-layout-scenario.py",
        ROOT / "scripts/quality/native-interactions-scenario.py",
        Path(__file__).resolve(),
        ROOT / "scripts/quality/native-input-linux.py",
    ]
    paths.extend(
        ROOT / relative
        for relative in (
            "package.json",
            "bun.lock",
            "tsconfig.json",
            "bunfig.toml",
            ".bun-version",
            "rust-toolchain.toml",
            "toolchain.json",
            "Cargo.toml",
            "Cargo.lock",
        )
    )
    for package in ("core", "protocol", "runtime"):
        paths.append(ROOT / "packages" / package / "package.json")
        paths.extend((ROOT / "packages" / package / "src").rglob("*.ts"))
    for crate in ("protocol", "gpui-host"):
        paths.append(ROOT / "native" / crate / "Cargo.toml")
        paths.extend((ROOT / "native" / crate / "src").rglob("*.rs"))
    return {str(path.relative_to(ROOT)): fingerprint(path) for path in sorted(paths)}


def require_owned_host(app, observed, pid, executable):
    """Check descendant identity and executable immediately before any signal."""
    table = DRIVER.process_table()
    owned = {row["pid"] for row in DRIVER.owned_processes(app.pid, table)}
    row = table.get(pid)
    if (
        pid not in owned
        or row is None
        or observed.get(pid) != row["start_ticks"]
        or row["state"] == "Z"
        or pid == app.pid
    ):
        raise RuntimeError("Native child ownership or process identity changed")
    if Path(f"/proc/{pid}/exe").resolve() != executable:
        raise RuntimeError("Owned X11 PID is not the explicitly supplied native host")
    return row


def interrupt(signum, _frame):
    # A second cancellation must not interrupt the bounded finally cleanup.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGALRM, signal.SIG_IGN)
    raise InterruptedError(f"Native diagnostics received signal {signum}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--scenario", required=True, choices=SCENARIOS)
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
    host = Path(os.environ.get("BUN_NATIVE_HOST", ""))
    if not host.is_absolute() or not host.is_file():
        parser.error("BUN_NATIVE_HOST must identify an absolute prebuilt executable")
    host = host.resolve()
    for tool in ("xdotool", "import"):
        if not shutil.which(tool):
            raise DRIVER.Unsupported(
                f"Required native diagnostic tool unavailable: {tool}"
            )
    args.output.mkdir()
    output = args.output.resolve()
    nonce = secrets.token_hex(16)
    sources = source_snapshot()
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "scenario": args.scenario,
        "mode": args.mode,
        "aot_verified_by_driver": False,
        "hostProfile": args.host_profile,
        "host": {"path": str(host), **fingerprint(host)},
        "system": {"platform": platform.platform(), "architecture": platform.machine()},
        "command": command,
        "sourceFiles": sources,
        "scope": "Actual GPUI child; X11/XTest software-GPU diagnostics. Paint reports are not presentation timestamps; scheduling observations are not a capacity benchmark.",
        "signals": [],
        "logs": {},
    }
    environment = {
        **os.environ,
        "BUN_NATIVE_DIAGNOSTICS_DIR": str(output),
        "BUN_NATIVE_DIAGNOSTICS_SCENARIO": args.scenario,
        "BUN_NATIVE_EVIDENCE_LOG": str(output / "native.jsonl"),
        "BUN_NATIVE_EVIDENCE_NONCE": nonce,
    }
    if args.scenario == "startup-failure":
        environment["DISPLAY"] = "bun-native-invalid-display"
    app = None
    observed = {}
    threads = []
    DRIVER.enable_subreaper()
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGALRM, interrupt)
    signal.alarm(30)

    def sample():
        rows = DRIVER.owned_processes(app.pid, DRIVER.process_table())
        observed.update({row["pid"]: row["start_ticks"] for row in rows})
        return {row["pid"] for row in rows}

    def application_records():
        return DRIVER.read_events(output / "application.jsonl", nonce, 0)

    def native_records():
        return DRIVER.read_events(output / "native.jsonl", nonce, 0)

    def wait_for(predicate, description, timeout=10):
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
            time.sleep(0.01)
        raise RuntimeError(f"Timed out waiting for {description}")

    def application_record(kind):
        return next(
            (row for row in application_records() if row.get("type") == kind), None
        )

    def owned_window(title):
        owned = sample()
        found = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", f"^{re.escape(title)}$"],
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
            if owner in owned:
                require_owned_host(app, observed, owner, host)
                return candidate, owner
        return None

    def capture_window(window, name):
        DRIVER.run(["import", "-window", window, str(output / name)], timeout=5)

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
        if args.scenario == "startup-failure":
            report["startupRejection"] = wait_for(
                lambda: application_record("startup-rejected"),
                "actual startup rejection",
            )
        else:
            mounted = wait_for(
                lambda: application_record("mounted"), "mounted native tree"
            )
            title = {
                "host-crash": "Bun Native native fault",
                "layout": "Bun Native layout",
                "interactions": "Bun Native interactions",
            }.get(args.scenario, "Bun Native scheduling audit")
            window, owner = wait_for(lambda: owned_window(title), "owned native window")
            report["window"] = {
                "id": window,
                "pid": owner,
                "startTicks": observed[owner],
            }
            wait_for(
                lambda: any(
                    row.get("type") == "rendered"
                    and row.get("tree_revision") == mounted.get("treeRevision", 1)
                    for row in native_records()
                ),
                "initial native paint",
            )
            renderer = wait_for(
                lambda: next(
                    (row for row in native_records() if row.get("type") == "renderer"),
                    None,
                ),
                "actual renderer metadata",
            )
            if renderer.get("gpu", {}).get("is_software_emulated") is not True:
                raise RuntimeError(
                    "The isolated diagnostic requires the selected software renderer"
                )
            report["renderer"] = renderer
            DRIVER.run(["xdotool", "windowactivate", "--sync", window])
            if DRIVER.run(["xdotool", "getwindowfocus"]) != window:
                raise RuntimeError("The owned native window did not gain focus")
            capture_window(window, "before.png")
            if args.scenario in ("layout", "interactions"):

                def require_layout_window():
                    require_owned_host(app, observed, owner, host)
                    if DRIVER.run(["xdotool", "getwindowpid", window]) != str(owner):
                        raise RuntimeError(
                            "The owned diagnostic window changed its native owner"
                        )

                scenario = LAYOUT if args.scenario == "layout" else INTERACTIONS
                scenario_arguments = [DRIVER]
                if args.scenario == "interactions":
                    scenario_arguments.append(LAYOUT)
                report[args.scenario + "Observations"] = scenario.run(
                    *scenario_arguments,
                    window,
                    output,
                    native_records,
                    application_records,
                    wait_for,
                    require_layout_window,
                    capture_window,
                )
            elif args.scenario == "host-crash":
                DRIVER.run(
                    [
                        "xdotool",
                        "mousemove",
                        "--window",
                        window,
                        "100",
                        "130",
                        "click",
                        "1",
                    ]
                )
                report["launchCallback"] = wait_for(
                    lambda: application_record("callback-waiting"),
                    "real OS-click callback",
                )
                row = require_owned_host(app, observed, owner, host)
                os.kill(owner, signal.SIGSTOP)
                report["signals"].append(
                    {
                        "pid": owner,
                        "startTicks": row["start_ticks"],
                        "signal": "SIGSTOP",
                    }
                )
                wait_for(
                    lambda: (
                        require_owned_host(app, observed, owner, host)["state"] == "T"
                    ),
                    "stopped native child",
                    1,
                )
                (output / "queue-after-stop").touch()
                pending = wait_for(
                    lambda: application_record("pending"), "pending application work"
                )
                if (
                    pending.get("ownership", {}).get("queuedTransactions") != 2
                    or pending.get("ownership", {}).get("activeCallbacks") != 1
                ):
                    raise RuntimeError(
                        "The required transaction/callback fault preconditions were not established"
                    )
                row = require_owned_host(app, observed, owner, host)
                os.kill(owner, signal.SIGKILL)
                report["signals"].append(
                    {
                        "pid": owner,
                        "startTicks": row["start_ticks"],
                        "signal": "SIGKILL",
                    }
                )
                report["containment"] = wait_for(
                    lambda: application_record("crash-contained"),
                    "precise native fault containment",
                )
            else:
                (output / "start").touch()
                wait_for(
                    lambda: application_record("stream-start"), "bounded command stream"
                )
                time.sleep(0.5)
                require_owned_host(app, observed, owner, host)
                if DRIVER.run(["xdotool", "getwindowfocus"]) != window:
                    raise RuntimeError("Window focus changed before native input")
                injected = time.monotonic()
                DRIVER.run(["xdotool", "type", "--clearmodifiers", "--delay", "0", "x"])
                report["injectionDurationMs"] = (time.monotonic() - injected) * 1000
                input_observed = None
                paint_during_producer = False
                while not application_record("completed"):
                    sample()
                    app_records = application_records()
                    if input_observed is None and any(
                        row.get("type") == "input" for row in app_records
                    ):
                        input_observed = (time.monotonic() - injected) * 1000
                    if not any(
                        row.get("type") == "producer-stopped" for row in app_records
                    ):
                        paint_during_producer |= any(
                            row.get("type") == "rendered"
                            and row.get("tree_revision", 0) > mounted["treeRevision"]
                            for row in native_records()
                        )
                    if app.poll() is not None:
                        raise RuntimeError(
                            f"Scheduling fixture failed before completion: {app.returncode}"
                        )
                    time.sleep(0.01)
                if not paint_during_producer:
                    raise RuntimeError(
                        "No native paint traversal progressed while the command producer was active"
                    )
                final_revision = application_record("completed")["treeRevision"]
                expected = DRIVER.fixture_paint(final_revision, "Stream completed", "x")
                expected["nodes"][0]["children"] = [3, 2, 4, 5, 6]
                expected["nodes"][1]["element"]["text"] = "Scheduling audit"
                wait_for(
                    lambda: any(
                        DRIVER.matches_paint(row, expected) for row in native_records()
                    ),
                    "complete final native tree/input paint",
                )
                capture_window(window, "after.png")
                report["inputObservedAfterInjectionMs"] = input_observed
                report["paintDuringProducerObserved"] = paint_during_producer
                report["nativePaintRevisions"] = [
                    row.get("tree_revision")
                    for row in native_records()
                    if row.get("type") == "rendered"
                ]
                (output / "close").touch()
        wait_for(lambda: app.poll() is not None, "fixture exit", 5)
        report["applicationExitCode"] = app.wait(timeout=1)
        if app.returncode != 0:
            raise RuntimeError(f"Native diagnostic fixture exited {app.returncode}")
        application = output / "application-result.json"
        if application.stat().st_size > DRIVER.MAX_LOG_BYTES:
            raise RuntimeError("Diagnostic fixture result exceeded its evidence bound")
        report["application"] = json.loads(application.read_text())
        if (
            report["application"].get("status") != "passed"
            or report["application"].get("scenario") != args.scenario
        ):
            raise RuntimeError(
                "Diagnostic fixture did not attest the requested scenario"
            )
        if source_snapshot() != sources or fingerprint(host) != {
            key: report["host"][key] for key in ("sha256", "bytes")
        }:
            raise RuntimeError(
                "Source or native artifact changed during the diagnostic"
            )
        report["status"] = "passed"
    except Exception as error:
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
                "scenario": args.scenario,
                "report": str(output / "result.json"),
                "error": report.get("error"),
            }
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
