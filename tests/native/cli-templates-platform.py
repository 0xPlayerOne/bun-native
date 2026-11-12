#!/usr/bin/env python3
"""Launch prepared CLI templates on a desktop, click the counter and close them.

`cli-templates.py prepare` creates, checks and AOT-builds the four templates.
This driver takes one prepared template and runs it either through the exact
`native dev --host` command (on a fresh copy of the generated source inside
the checkout) or as the inspected AOT package with its adjacent host. It then:

1. waits for the host's own paint record of the initial counter tree;
2. finds the owned native window through the platform input driver that the
   native-platform and workspace steps already use (`MacInput` and the SDK
   helper on macOS, `WorkspaceInput` on Windows, `LinuxInput` on X11);
3. clicks the centre of the button's painted bounds with a real OS event;
4. requires the host's pointer trace to show a left down and up inside those
   bounds and its paint record to show the exact `Clicks: 1` tree;
5. ends the session with an OS window close (Accessibility close button,
   WM_SYSCOMMAND SC_CLOSE, Alt+F4) or, on POSIX, SIGINT to the application's
   process group, which is what a terminal's Ctrl-C sends (#584);
6. requires exit code 0, no unexpected-host-exit report, no surviving host,
   no leftover development bundle and unchanged prepared artifacts.

The template source is never changed. Nothing here asks for an OS permission:
a missing input or Accessibility grant is reported as `unavailable` (exit 2),
never as a pass.
"""

import argparse
import importlib.util
import json
import logging
import os
import platform
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

LOGGER = logging.getLogger(__name__)
REPOSITORY = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, REPOSITORY / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TEMPLATES = load("cli_templates", "tests/native/cli-templates.py")
DIAGNOSTICS = load("native_diagnostics", "scripts/quality/native-diagnostics-linux.py")
EVIDENCE = DIAGNOSTICS.DRIVER
OS_INPUT = load("native_platform_input", "scripts/quality/native-platform-input.py")
CLOSES = ("os", "sigint")
# Output of the runtime's NativeHostExitError, as reported in #584.
UNEXPECTED_EXIT_MARKERS = ("exited unexpectedly", "NativeHostExitError")


def cpu_model():
    """The exact CPU name the OS reports, for the run record."""
    try:
        if sys.platform == "darwin":
            return subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
            ).stdout.strip()
        if sys.platform == "linux":
            for line in Path("/proc/cpuinfo").read_text().splitlines():
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
        if sys.platform == "win32":
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            ) as key:
                return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return platform.processor() or None


def title(framework):
    return f"Bun Native {framework.title()}"


def button_target(layout, initial):
    """The button node of the expected initial tree, at its painted geometry."""
    buttons = [
        node["node_id"]
        for node in initial["nodes"]
        if node["element"]["kind"] == "button"
    ]
    if len(buttons) != 1:
        raise ValueError("The counter tree must contain exactly one button")
    x, y, viewport = OS_INPUT.pointer_target(layout, buttons[0])
    bounds = next(
        node["bounds"] for node in layout["nodes"] if node["node_id"] == buttons[0]
    )
    return {
        "nodeId": buttons[0],
        "logicalPoint": [x, y],
        "viewport": viewport,
        "bounds": bounds,
    }


def latest_layout(records, window_id, tree_revision):
    layouts = [
        row["layout"]
        for row in records
        if row.get("type") == "layout"
        and row.get("window_id") == window_id
        and row.get("tree_revision") == tree_revision
    ]
    return layouts[-1] if layouts else None


def find_paint(records, expected):
    return next((row for row in records if EVIDENCE.matches_paint(row, expected)), None)


def later_revisions(records, window_id, tree_revision):
    """Painted revisions after the expected one: a duplicated or stray update."""
    return sorted(
        {
            row["tree_revision"]
            for row in records
            if row.get("type") == "rendered"
            and row.get("window_id") == window_id
            and type(row.get("tree_revision")) is int
            and row["tree_revision"] > tree_revision
        }
    )


def pointer_click(records, window_id, bounds):
    """One left down then up that GPUI received inside the button's bounds."""
    left, top, width, height = bounds

    def inside(row):
        position = row.get("position")
        return (
            isinstance(position, list)
            and len(position) == 2
            and all(type(value) in (int, float) for value in position)
            and left <= position[0] < left + width
            and top <= position[1] < top + height
        )

    down = None
    for row in records:
        if (
            row.get("type") != "pointer_trace"
            or row.get("stage") != "gpui-window-input"
            or row.get("window_id") != window_id
            or row.get("button") != "Left"
        ):
            continue
        if row.get("event") == "down" and inside(row):
            down = row
        elif (
            row.get("event") == "up"
            and down is not None
            and inside(row)
            and row.get("trace_index", 0) > down.get("trace_index", 0)
        ):
            return {"down": down, "up": row}
    return None


def close_errors(*, exit_code, output, host_alive, leftover_bundles):
    """Every reason a finished session did not end cleanly; empty means clean."""
    errors = []
    if exit_code != 0:
        errors.append(f"application exited {exit_code}")
    for marker in UNEXPECTED_EXIT_MARKERS:
        if marker in output:
            errors.append(f"application output reports '{marker}'")
    if host_alive:
        errors.append("the native host outlived the application")
    if leftover_bundles:
        errors.append(f"development bundles were left behind: {leftover_bundles}")
    return errors


def launch(provenance, package_root, case, mode, owned):
    """The exact command, cwd and expected host for one prepared template."""
    prepared = provenance["cases"][case]
    package = package_root / case / "package"
    manifest = json.loads((package / "manifest.json").read_text())
    bun = Path(provenance["compiler"]["path"])
    if mode == "development":
        project = owned / "project"
        shutil.copytree(package_root / case / "source", project)
        for item in prepared["source"]:
            TEMPLATES.require_artifact(project / item["path"], item)
        host = Path(provenance["host"]["path"])
        # What `bun run native dev <project> --host <host>` executes; run
        # directly so the host is this process's child for the OS drivers.
        command = [
            str(bun),
            str(REPOSITORY / "scripts/native.ts"),
            "dev",
            str(project),
            "--host",
            str(host),
        ]
        return command, REPOSITORY, host, project
    host = package / manifest["host"]["file"]
    return [str(package / manifest["application"]["file"])], None, host, None


def input_driver(app, host):
    if sys.platform == "darwin":
        return OS_INPUT.MacInput(app.pid, host), (OS_INPUT.InputUnavailable,)
    if sys.platform == "win32":
        workspace = load(
            "native_workspace_windows", "scripts/quality/native-workspace-windows.py"
        )
        try:
            driver = workspace.WorkspaceInput(app.pid, host)
        except workspace.WINDOWS.InputUnavailable as error:
            raise OS_INPUT.InputUnavailable(str(error)) from error
        return driver, (workspace.WINDOWS.InputUnavailable,)
    if sys.platform == "linux":
        return OS_INPUT.LinuxInput(app, host, DIAGNOSTICS), (OS_INPUT.InputUnavailable,)
    raise OS_INPUT.InputUnavailable("No OS input driver for this platform")


def os_close(driver):
    if sys.platform == "linux":
        # The owned window is made active first; the window manager closes it.
        driver._foreground()
        EVIDENCE.run(["xdotool", "key", "--clearmodifiers", "alt+F4"])
        return "Alt+F4 to the owned X11 window through the test window manager"
    driver.os_close()
    if sys.platform == "darwin":
        return "Accessibility press of the owned window's standard close button"
    return "WM_SYSCOMMAND SC_CLOSE posted to the owned window"


def host_alive(driver, state, host):
    """Whether the observed host process still runs, by handle or PID+image."""
    if sys.platform == "win32":
        # The handle the driver opened when it first observed the host; 258 is
        # WAIT_TIMEOUT, i.e. that exact process is still running.
        return driver.kernel.WaitForSingleObject(driver.host["handle"], 0) == 258
    pid = int(state["host"]["pid"])
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat=,command="],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    line = result.stdout.strip()
    return bool(line) and not line.startswith("Z") and str(host) in line


def wait(predicate, description, app, timeout):
    until = time.monotonic() + timeout
    while True:
        result = predicate()
        if result:
            return result
        if app.poll() is not None:
            result = predicate()
            if result:
                return result
            raise RuntimeError(
                f"Application exited {app.returncode} before {description}"
            )
        if time.monotonic() >= until:
            raise RuntimeError(f"Timed out waiting for {description}")
        time.sleep(0.02)


def force_stop(app):
    """Bounded cleanup of a failed run, including the host's own session."""
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(app.pid)],
            capture_output=True,
            timeout=15,
            check=False,
        )
    else:
        app.terminate()
    try:
        app.wait(timeout=10)
    except subprocess.TimeoutExpired:
        app.kill()
        app.wait(timeout=5)


def run(args):
    package_root = args.packages.resolve(strict=True)
    provenance = json.loads((package_root / "provenance.json").read_text())
    prepared = provenance["cases"][args.case]
    framework = prepared["framework"]
    bun = Path(provenance["compiler"]["path"])
    TEMPLATES.require_artifact(bun, provenance["compiler"])
    TEMPLATES.require_artifact(Path(provenance["host"]["path"]), provenance["host"])
    package = package_root / args.case / "package"
    TEMPLATES.require_artifact(package / "manifest.json", prepared["manifest"])
    manifest = json.loads((package / "manifest.json").read_text())
    artifacts = {
        key: package / manifest[key]["file"]
        for key in ("application", "developmentModule", "host")
    }
    for key, path in artifacts.items():
        TEMPLATES.require_artifact(path, manifest[key])
    for item in prepared["source"]:
        TEMPLATES.require_artifact(
            package_root / args.case / "source" / item["path"], item
        )
    if TEMPLATES.source_identity() != provenance["source"]:
        raise RuntimeError("Checkout source differs from the prepared templates")
    if args.close == "sigint" and sys.platform == "win32":
        raise SystemExit("SIGINT to a process group is a POSIX close")

    args.output.mkdir(parents=True)
    output = args.output.resolve()
    nonce = secrets.token_hex(16)
    initial = TEMPLATES.counter_paint(framework, 0)
    clicked = TEMPLATES.counter_paint(framework, 1)
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "case": args.case,
        "framework": framework,
        "language": prepared["language"],
        "mode": args.mode,
        "close": args.close,
        "system": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu": cpu_model(),
            "cpuCount": os.cpu_count(),
            "python": platform.python_version(),
            "runner": {
                key: os.environ[key]
                for key in ("ImageOS", "ImageVersion", "RUNNER_NAME")
                if key in os.environ
            },
        },
        "source": provenance["source"]["commit"],
        "compiler": provenance["compiler"],
        "preparedHost": provenance["host"],
        "manifest": prepared["manifest"],
        "scope": "One OS click on the owned window of an unchanged generated template, checked against the host's own pointer trace and paint records, then the requested close. A paint record is not a screenshot or proof of display presentation.",
        "logs": {},
    }
    (REPOSITORY / ".bun-native").mkdir(exist_ok=True)
    owned = Path(
        tempfile.mkdtemp(prefix="cli-platform-", dir=REPOSITORY / ".bun-native")
    )
    app = driver = state = None
    threads = []
    try:
        command, cwd, host, project = launch(
            provenance, package_root, args.case, args.mode, owned
        )
        host = host.resolve(strict=True)
        report["command"] = command
        report["host"] = {"path": str(host), **TEMPLATES.artifact(host)}
        environment = {
            **os.environ,
            "BUN_NATIVE_HOST_PROFILE": "release",
            "BUN_NATIVE_EVIDENCE_LOG": str(output / "native.jsonl"),
            "BUN_NATIVE_EVIDENCE_NONCE": nonce,
            "BUN_NATIVE_POINTER_TRACE": "1",
        }
        environment.pop("BUN_NATIVE_HOST", None)
        if args.mode == "development":
            # The checkout's `native` package script sets this before the CLI.
            environment["MIMALLOC_PURGE_DELAY"] = "0"
        native = EVIDENCE.EventLog(output / "native.jsonl", nonce)
        started = time.monotonic()
        app = subprocess.Popen(
            command,
            cwd=cwd or tempfile.gettempdir(),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # The application leads its own process group, as a shell's
            # foreground job does, so SIGINT reaches exactly what Ctrl-C would.
            **({} if sys.platform == "win32" else {"process_group": 0}),
        )
        for name, stream in (("stdout", app.stdout), ("stderr", app.stderr)):
            stats = {"written_bytes": 0, "discarded_bytes": 0}
            report["logs"][name] = stats
            thread = threading.Thread(
                target=EVIDENCE.capture,
                args=(stream, output / f"{name}.log", stats),
                daemon=True,
            )
            thread.start()
            threads.append(thread)
        first = wait(
            lambda: find_paint(native.read(), initial),
            "the initial counter paint",
            app,
            args.timeout,
        )
        report["initialPaintSeconds"] = round(time.monotonic() - started, 3)
        report["renderer"] = next(
            (row for row in native.read() if row.get("type") == "renderer"), None
        )
        driver, unavailable = input_driver(app, host)
        state = wait(
            lambda: driver.observe(title(framework)),
            "the owned visible native window",
            app,
            15,
        )
        report["window"] = {
            key: value
            for key, value in state.items()
            if key in ("window", "host", "application")
        }
        layout = wait(
            lambda: latest_layout(native.read(), first["window_id"], 1),
            "the initial native layout",
            app,
            5,
        )
        target = button_target(layout, initial)
        report["pointerTarget"] = target
        if sys.platform == "darwin":
            driver.activate()
        report["pointer"] = driver.click(*target["logicalPoint"], target["viewport"])
        wait(
            lambda: find_paint(native.read(), clicked),
            "the 'Clicks: 1' native paint",
            app,
            10,
        )
        report["pointerTrace"] = wait(
            lambda: pointer_click(native.read(), first["window_id"], target["bounds"]),
            "a native left down and up inside the button",
            app,
            5,
        )
        report["labelChanged"] = {"from": "Clicks: 0", "to": "Clicks: 1"}
        # Leave time for a duplicated activation to paint before closing.
        time.sleep(0.5)
        if extra := later_revisions(native.read(), first["window_id"], 2):
            raise RuntimeError(f"Unexpected later paints after one click: {extra}")
        if args.close == "os":
            report["closeMethod"] = os_close(driver)
        else:
            os.killpg(app.pid, signal.SIGINT)
            report["closeMethod"] = "SIGINT to the application's process group"
        app.wait(timeout=20)
        report["exitCode"] = app.returncode
        report["exitSeconds"] = round(time.monotonic() - started, 3)
        until = time.monotonic() + 5
        while (alive := host_alive(driver, state, host)) and time.monotonic() < until:
            time.sleep(0.05)
        for thread in threads:
            thread.join(timeout=5)
        text = "".join(
            (output / f"{name}.log").read_text(encoding="utf-8", errors="replace")
            for name in ("stdout", "stderr")
        )
        leftovers = (
            sorted(path.name for path in (project / ".bun-native").glob("dev-*"))
            if project is not None and (project / ".bun-native").exists()
            else []
        )
        report["hostAlive"] = alive
        report["leftoverDevelopmentBundles"] = leftovers
        if errors := close_errors(
            exit_code=app.returncode,
            output=text,
            host_alive=alive,
            leftover_bundles=leftovers,
        ):
            raise RuntimeError("; ".join(errors))
        for key, path in artifacts.items():
            TEMPLATES.require_artifact(path, manifest[key])
        TEMPLATES.require_artifact(bun, provenance["compiler"])
        report["status"] = "passed"
    except OS_INPUT.InputUnavailable as error:
        report["status"] = "unavailable"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    except Exception as error:
        if driver is not None and isinstance(error, unavailable):
            report["status"] = "unavailable"
        LOGGER.exception("Template platform run failed")
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if app is not None and app.poll() is None:
            report["forcedTermination"] = True
            force_stop(app)
            if report["status"] == "passed":
                report["status"] = "failed"
        else:
            report.setdefault("forcedTermination", False)
        if (
            state is not None
            and sys.platform != "win32"
            and host_alive(driver, state, host)
        ):
            # Since #584 the host has its own POSIX session; end it directly.
            os.kill(int(state["host"]["pid"]), signal.SIGKILL)
            report["forcedTermination"] = True
            report["status"] = "failed"
        if driver is not None and sys.platform == "win32":
            driver.close()
        for thread in threads:
            thread.join(timeout=1)
        if any(stats["discarded_bytes"] for stats in report["logs"].values()):
            report["status"] = "failed"
        shutil.rmtree(owned, ignore_errors=True)
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                key: report.get(key)
                for key in ("status", "case", "mode", "close", "error")
            }
        )
    )
    return {"passed": 0, "unavailable": 2}.get(report["status"], 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packages", type=Path, required=True)
    parser.add_argument("--case", choices=TEMPLATES.CASES, required=True)
    parser.add_argument("--mode", choices=["development", "aot"], required=True)
    parser.add_argument("--close", choices=CLOSES, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=60)
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
