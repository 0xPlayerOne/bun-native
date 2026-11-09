"""macOS driver for the Solid and React workspace references (#248, #250).

Runs the same scenario modules as native-diagnostics-linux.py against the real
GPUI host on macOS. The scenarios speak a small X11 vocabulary (xdotool click,
wheel, key, type, windowsize, alt+F4); MacCommands maps each of those words to
the SDK helper's owned-window actions, with the same identity, foreground and
target checks as the click. Nothing in a scenario changes: its assertions read
the host's own paint and layout records and its own screenshots.

An OS close is the standard close button pressed through Accessibility, and a
resize sets the window's Accessibility size. Both need the process to be
trusted for Accessibility; the helper never asks for it, and reports a missing
grant as unavailable (exit 2), never as a pass.
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
import threading
import time
from pathlib import Path

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]
TITLES = {
    "react-workspace": "Bun Native React Workspace",
    "solid-workspace": "Bun Native Solid Workspace",
}
X11_MODIFIERS = {
    "ctrl": "control",
    "shift": "shift",
    "alt": "option",
    "super": "command",
}
X11_KEYS = {
    "Return",
    "Escape",
    "BackSpace",
    "Delete",
    "Tab",
    "Left",
    "Right",
    "Up",
    "Down",
    "Home",
    "End",
    "a",
}


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DIAGNOSTICS = load("native_diagnostics", "scripts/quality/native-diagnostics-linux.py")
EVIDENCE = DIAGNOSTICS.DRIVER
FAULT = load("native_fault_macos", "scripts/quality/native-fault-macos.py")
OS_INPUT = load("native_platform_input", "scripts/quality/native-platform-input.py")
SCENARIOS = {
    "react-workspace": DIAGNOSTICS.WORKSPACE,
    "solid-workspace": DIAGNOSTICS.SOLID_WORKSPACE,
}
SOURCES = (
    "scripts/quality/native-workspace-macos.py",
    "scripts/quality/native-platform-input.py",
    "scripts/quality/native-platform-macos.m",
    "scripts/quality/native-react-workspace-scenario.py",
    "scripts/quality/native-solid-workspace-scenario.py",
    "scripts/quality/native-solid-workspace-paint.py",
    "scripts/quality/native-layout-scenario.py",
    "tests/native/react-workspace.tsx",
    "tests/native/solid-workspace.tsx",
)


def image_tool():
    """ImageMagick 7 installs `magick`; 6 and the 7 shim install `convert`."""
    for name in ("magick", "convert"):
        if path := shutil.which(name):
            return path
    return None


class MacCommands:
    """The scenarios' X11 command words, carried out on the owned macOS window."""

    def __init__(self, mac_input, title, viewport, image):
        self.input, self.title, self.viewport, self.image = (
            mac_input,
            title,
            viewport,
            image,
        )
        self.window = None
        self.log = []

    def observe(self):
        state = self.input.observe(self.title)
        if state is None:
            raise RuntimeError("The owned macOS window is no longer observable")
        if self.window is not None and str(state["window"]["id"]) != self.window:
            raise RuntimeError("The owned macOS window number changed")
        return state

    def run(self, command, timeout=3):
        if command[:1] == ["convert"]:
            return EVIDENCE.run([self.image, *command[1:]], timeout=max(timeout, 10))
        if command[:1] != ["xdotool"] or len(command) < 2:
            raise RuntimeError(f"No macOS equivalent for {command[:2]}")
        verb, arguments = command[1], command[2:]
        self.log.append([verb, *arguments[:8]])
        if verb == "getwindowfocus":
            state = self.observe()
            return self.window if state["frontmostPID"] == state["host"]["pid"] else "0"
        if verb == "getwindowpid":
            return str(self.observe()["host"]["pid"])
        if verb == "getwindowgeometry" and arguments[:1] == ["--shell"]:
            self.target(arguments[1])
            state = self.observe()
            x, y, _, _ = state["window"]["frame"]
            width, height = state["window"]["titledContentSize"]
            return "\n".join(
                (
                    f"WINDOW={self.window}",
                    f"X={round(x)}",
                    f"Y={round(y)}",
                    f"WIDTH={round(width)}",
                    f"HEIGHT={round(height)}",
                    "SCREEN=0",
                )
            )
        if verb == "mousemove":
            return self.pointer(arguments)
        if (
            verb == "key"
            and arguments[:1] == ["--clearmodifiers"]
            and len(arguments) == 2
        ):
            return self.key(arguments[1])
        if (
            verb == "type"
            and arguments[:3] == ["--clearmodifiers", "--delay", arguments[2]]
            and len(arguments) == 4
        ):
            self.input.type_printable(arguments[3], int(arguments[2]))
            return ""
        if verb == "windowsize" and arguments[:1] == ["--sync"] and len(arguments) == 4:
            self.target(arguments[1])
            self.input.resize(int(arguments[2]), int(arguments[3]), self.viewport())
            return ""
        if verb == "windowactivate":
            self.input.activate()
            return ""
        raise RuntimeError(f"No macOS equivalent for xdotool {verb}")

    def target(self, window):
        if str(window) != self.window:
            raise RuntimeError("Input addressed a window this driver does not own")

    def pointer(self, arguments):
        # mousemove --window W X Y click [--repeat N --delay D] BUTTON
        if (
            arguments[:1] != ["--window"]
            or len(arguments) < 6
            or arguments[4] != "click"
        ):
            raise RuntimeError(f"Unsupported pointer command {arguments}")
        self.target(arguments[1])
        x, y = float(arguments[2]), float(arguments[3])
        rest = arguments[5:]
        if rest == ["1"]:
            self.input.click(x, y, self.viewport())
            return ""
        if (
            len(rest) == 5
            and rest[0] == "--repeat"
            and rest[2] == "--delay"
            and rest[4] in ("4", "5")
        ):
            # X11 buttons 4 and 5 are one wheel line up and down.
            self.input.scroll(
                x,
                y,
                self.viewport(),
                1 if rest[4] == "4" else -1,
                int(rest[1]),
                int(rest[3]),
            )
            return ""
        raise RuntimeError(f"Unsupported pointer command {arguments}")

    def key(self, combination):
        if combination == "alt+F4":
            # The X11 window-manager close; on macOS, the standard close button.
            self.input.os_close()
            return ""
        *modifiers, name = combination.split("+")
        if name not in X11_KEYS or any(item not in X11_MODIFIERS for item in modifiers):
            raise RuntimeError(f"Unsupported key {combination}")
        self.input.key(name, [X11_MODIFIERS[item] for item in modifiers])
        return ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--scenario", required=True, choices=sorted(SCENARIOS))
    parser.add_argument("--mode", required=True, choices=("development", "aot"))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    host = Path(os.environ.get("BUN_NATIVE_HOST", ""))
    if platform.system() != "Darwin":
        parser.error("This driver requires macOS")
    if not command or not host.is_absolute() or not host.is_file():
        parser.error("Supply a fixture command and absolute prebuilt BUN_NATIVE_HOST")
    image = image_tool()
    if image is None:
        raise SystemExit(
            "Workspace pixel checks require ImageMagick (magick or convert)"
        )
    host = host.resolve()
    args.output.mkdir()
    output = args.output.resolve()
    nonce = secrets.token_hex(16)
    title = TITLES[args.scenario]
    sources = {
        relative: DIAGNOSTICS.fingerprint(ROOT / relative) for relative in SOURCES
    }
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "scenario": args.scenario,
        "platform": "macos",
        "mode": args.mode,
        "host": {"path": str(host), **DIAGNOSTICS.fingerprint(host)},
        "command": command,
        "system": {
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "macos": platform.mac_ver()[0],
        },
        "sourceFiles": sources,
        "scope": "Actual GPUI host on macOS driven by CoreGraphics pointer, wheel and key events and Accessibility resize/close on the owned window. The scenario modules and their native paint, layout and pixel assertions are the Linux ones, unchanged.",
        "logs": {},
    }
    environment = {
        **os.environ,
        "BUN_NATIVE_HOST": str(host),
        "BUN_NATIVE_DIAGNOSTICS_DIR": str(output),
        "BUN_NATIVE_DIAGNOSTICS_SCENARIO": args.scenario,
        "BUN_NATIVE_EVIDENCE_LOG": str(output / "native.jsonl"),
        "BUN_NATIVE_EVIDENCE_NONCE": nonce,
    }
    observed = {}
    threads = []
    app = None
    commands = None
    application_log = EVIDENCE.EventLog(output / "application.jsonl", nonce)
    native_log = EVIDENCE.EventLog(output / "native.jsonl", nonce)

    def application_records():
        return application_log.read()

    def native_records():
        return native_log.read()

    def wait_for(predicate, description, timeout=10):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            result = predicate()
            if result:
                return result
            if app.poll() is not None:
                result = predicate()
                if result:
                    return result
                raise RuntimeError(
                    f"Fixture exited {app.returncode} before {description}"
                )
            time.sleep(0.01)
        raise RuntimeError(f"Timed out waiting for {description}")

    def application_record(kind):
        return next(
            (row for row in application_records() if row.get("type") == kind), None
        )

    def viewport():
        layout = next(
            (
                row["layout"]
                for row in reversed(native_records())
                if row.get("type") == "layout"
            ),
            None,
        )
        if not layout or not isinstance(layout.get("viewport"), list):
            raise RuntimeError("No native layout viewport is available for OS input")
        return layout["viewport"]

    def require_owned():
        FAULT.host_row(app, host, observed)
        commands.observe()

    def capture(window, name):
        commands.target(window)
        state = commands.observe()
        raw = output / ("window-" + name)
        EVIDENCE.run(["screencapture", "-x", "-o", f"-l{window}", str(raw)], timeout=5)
        # Crop the title bar and scale Retina pixels so the image is exactly the
        # GPUI viewport, as an X11 client-window capture is.
        frame = state["window"]["frame"]
        width, height = viewport()
        scale = (
            float(EVIDENCE.run([image, str(raw), "-format", "%w", "info:"])) / frame[2]
        )
        side = (frame[2] - width) / 2
        top = frame[3] - height - side
        EVIDENCE.run(
            [
                image,
                str(raw),
                "-crop",
                f"{round(width * scale)}x{round(height * scale)}+{round(side * scale)}+{round(top * scale)}",
                "+repage",
                "-filter",
                "Box",
                "-resize",
                f"{width}x{height}!",
                str(output / name),
            ],
            timeout=10,
        )

    signal.signal(signal.SIGALRM, DIAGNOSTICS.interrupt)
    signal.alarm(240)
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
        mac_input = OS_INPUT.MacInput(app.pid, host)
        report["osHelper"] = {
            "path": str(mac_input.helper),
            **DIAGNOSTICS.fingerprint(mac_input.helper),
        }
        commands = MacCommands(mac_input, title, viewport, image)
        state = wait_for(
            lambda: mac_input.observe(title), "owned visible native window"
        )
        commands.window = str(state["window"]["id"])
        FAULT.host_row(app, host, observed)
        report["window"] = state["window"]
        wait_for(
            lambda: any(
                row.get("type") == "rendered"
                and row.get("tree_revision") == mounted.get("treeRevision", 1)
                for row in native_records()
            ),
            "initial native paint",
        )
        report["renderer"] = wait_for(
            lambda: next(
                (row for row in native_records() if row.get("type") == "renderer"), None
            ),
            "actual renderer metadata",
        )
        mac_input.activate()
        capture(commands.window, "before.png")
        report[args.scenario + "Observations"] = SCENARIOS[args.scenario].run(
            commands,
            DIAGNOSTICS.LAYOUT,
            commands.window,
            output,
            native_records,
            application_records,
            wait_for,
            require_owned,
            capture,
        )
        report["osCommands"] = commands.log
        wait_for(lambda: app.poll() is not None, "fixture exit after the OS close", 10)
        report["applicationExitCode"] = app.returncode
        if app.returncode != 0:
            raise RuntimeError(f"Workspace fixture exited {app.returncode}")
        result = output / "application-result.json"
        if result.stat().st_size > EVIDENCE.MAX_LOG_BYTES:
            raise RuntimeError("Workspace fixture result exceeded its evidence bound")
        report["application"] = json.loads(result.read_text(encoding="utf-8"))
        if (
            report["application"].get("status") != "passed"
            or report["application"].get("scenario") != args.scenario
        ):
            raise RuntimeError(
                "Workspace fixture did not attest the requested scenario"
            )
        survivors = [
            row
            for row in FAULT.owned_processes(os.getpid(), FAULT.process_table())
            if Path(row["executable"]).resolve() == host
        ]
        report["hostSurvivors"] = len(survivors)
        if survivors:
            raise RuntimeError("The native host outlived the closed workspace")
        if {
            relative: DIAGNOSTICS.fingerprint(ROOT / relative) for relative in SOURCES
        } != sources or DIAGNOSTICS.fingerprint(host) != {
            key: report["host"][key] for key in ("sha256", "bytes")
        }:
            raise RuntimeError(
                "Source or native artifact changed during the workspace run"
            )
        report["status"] = "passed"
    except OS_INPUT.InputUnavailable as error:
        report["status"] = "unavailable"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    except Exception as error:
        LOGGER.exception("macOS workspace scenario failed")
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        signal.alarm(0)
        if commands is not None:
            report.setdefault("osCommands", commands.log)
        if app is not None and app.poll() is None:
            app.terminate()
            try:
                app.wait(timeout=10)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait(timeout=3)
            report["status"] = (
                "failed" if report["status"] == "passed" else report["status"]
            )
        for thread in threads:
            thread.join(timeout=1)
        if (
            any(stats["discarded_bytes"] for stats in report["logs"].values())
            and report["status"] == "passed"
        ):
            report["status"] = "failed"
        (output / "result.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
    print(
        json.dumps(
            {
                "status": report["status"],
                "scenario": args.scenario,
                "mode": args.mode,
                "report": str(output / "result.json"),
                "error": report.get("error"),
            }
        )
    )
    return {"passed": 0, "unavailable": 2}.get(report["status"], 1)


if __name__ == "__main__":
    raise SystemExit(main())
