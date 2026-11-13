"""Windows driver for the React (and Solid) workspace references (#248, #250).

Runs the same scenario modules as native-diagnostics-linux.py against the real
GPUI host on Windows. The scenarios speak a small X11 vocabulary (xdotool
click, wheel, key, type, windowsize, alt+F4); WindowsCommands maps each word to
SendInput on the owned window, behind the identity, desktop, foreground and
target checks of native-platform-windows.py. Nothing in a scenario changes:
its assertions read the host's own paint and layout records and its own
screenshots.

A resize is SetWindowPos on the owned top-level window, sized so its client
area is the requested viewport. The OS close is the system Close command
(WM_SYSCOMMAND SC_CLOSE), which is what Alt+F4 and the title-bar close button
send to a window. Screenshots copy the owned client area from the composed
desktop, so the window must be foreground and unobscured, as for input.
"""

import argparse
import ctypes as c
import glob
import json
import logging
import os
import platform
import secrets
import shutil
import subprocess
import threading
import time
import zlib
from pathlib import Path

from . import native_diagnostics_linux as DIAGNOSTICS
from . import native_platform_windows as WINDOWS
from .common import ROOT, harness_sources

LOGGER = logging.getLogger(__name__)
TITLES = {
    "react-workspace": "Bun Native React Workspace",
    "solid-workspace": "Bun Native Solid Workspace",
}
# The size each fixture opens at; the scenarios assert this viewport.
SIZES = {"react-workspace": [1000, 760], "solid-workspace": [1120, 760]}
# One X11 wheel notch (button 4/5). GPUI's Windows client scrolls
# SPI_GETWHEELSCROLLLINES (3 by default) lines per WHEEL_DELTA, as its X11
# client scrolls SCROLL_LINES (3) per notch; the driver records the setting.
WHEEL_DELTA = 120
# Virtual-key code and whether it is an extended key.
X11_KEYS = {
    "Return": (0x0D, False),
    "Escape": (0x1B, False),
    "BackSpace": (0x08, False),
    "Tab": (0x09, False),
    "Delete": (0x2E, True),
    "Left": (0x25, True),
    "Up": (0x26, True),
    "Right": (0x27, True),
    "Down": (0x28, True),
    "Home": (0x24, True),
    "End": (0x23, True),
    "a": (0x41, False),
}
X11_MODIFIERS = {
    "ctrl": (0x11, False),
    "shift": (0x10, False),
    "alt": (0x12, False),
    "super": (0x5B, True),
}
KEYEVENTF_EXTENDEDKEY = 0x1
KEYEVENTF_KEYUP = 0x2
KEYEVENTF_UNICODE = 0x4
MOUSEEVENTF_MOVE_ABSOLUTE_VIRTUAL = 0x0001 | 0x8000 | 0x4000
MOUSEEVENTF_WHEEL = 0x0800
WM_SYSCOMMAND = 0x0112
SC_CLOSE = 0xF060


EVIDENCE = DIAGNOSTICS.DRIVER
SCENARIOS = {
    "react-workspace": DIAGNOSTICS.WORKSPACE,
    "solid-workspace": DIAGNOSTICS.SOLID_WORKSPACE,
}
SOURCES = (
    *harness_sources(),
    "tests/native/react-workspace.tsx",
    "tests/native/solid-workspace.tsx",
    "examples/react-workspace/app.tsx",
    "examples/react-workspace/model.ts",
)


def image_tool():
    """ImageMagick 7's `magick`. Windows ships an unrelated convert.exe."""
    if path := shutil.which("magick"):
        return path
    installed = sorted(glob.glob(r"C:\Program Files\ImageMagick-*\magick.exe"))
    return installed[-1] if installed else None


def png(path, width, height, bgra):
    """Write 8-bit RGB rows as a PNG; no imaging library is assumed."""
    stride = width * 4
    raw = bytearray()
    for row in range(height):
        line = bgra[row * stride : (row + 1) * stride]
        raw.append(0)
        rgb = bytearray(width * 3)
        rgb[0::3], rgb[1::3], rgb[2::3] = line[2::4], line[1::4], line[0::4]
        raw += rgb

    def chunk(kind, data):
        body = kind + data
        return (
            len(data).to_bytes(4, "big")
            + body
            + (zlib.crc32(body) & 0xFFFFFFFF).to_bytes(4, "big")
        )

    header = (
        width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes((8, 2, 0, 0, 0))
    )
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + chunk(b"IEND", b"")
    )


class BitmapInfoHeader(c.Structure):
    _fields_ = [
        ("size", WINDOWS.DWORD),
        ("width", WINDOWS.LONG),
        ("height", WINDOWS.LONG),
        ("planes", WINDOWS.WORD),
        ("bit_count", WINDOWS.WORD),
        ("compression", WINDOWS.DWORD),
        ("size_image", WINDOWS.DWORD),
        ("x_pixels", WINDOWS.LONG),
        ("y_pixels", WINDOWS.LONG),
        ("used", WINDOWS.DWORD),
        ("important", WINDOWS.DWORD),
    ]


class WorkspaceInput(WINDOWS.WindowsInput):
    """The shared owned-window controller plus the workspace's extra actions."""

    def _bind(self):
        super()._bind()
        self.gdi = c.WinDLL("gdi32", use_last_error=True)
        handle, rect = WINDOWS.HANDLE, WINDOWS.Rect

        def bind(library, name, arguments, result):
            function = getattr(library, name)
            function.argtypes = arguments
            function.restype = result

        bind(self.user, "GetWindowRect", [handle, c.POINTER(rect)], WINDOWS.BOOL)
        bind(
            self.user,
            "SetWindowPos",
            [handle, handle, c.c_int, c.c_int, c.c_int, c.c_int, c.c_uint],
            WINDOWS.BOOL,
        )
        bind(
            self.user,
            "PostMessageW",
            [handle, c.c_uint, c.c_size_t, c.c_ssize_t],
            WINDOWS.BOOL,
        )
        bind(self.user, "MapVirtualKeyW", [c.c_uint, c.c_uint], c.c_uint)
        bind(
            self.user,
            "SystemParametersInfoW",
            [c.c_uint, c.c_uint, c.c_void_p, c.c_uint],
            WINDOWS.BOOL,
        )
        bind(self.user, "GetDC", [handle], handle)
        bind(self.user, "ReleaseDC", [handle, handle], c.c_int)
        bind(self.gdi, "CreateCompatibleDC", [handle], handle)
        bind(self.gdi, "CreateCompatibleBitmap", [handle, c.c_int, c.c_int], handle)
        bind(self.gdi, "SelectObject", [handle, handle], handle)
        bind(
            self.gdi,
            "BitBlt",
            [handle, *[c.c_int] * 4, handle, c.c_int, c.c_int, WINDOWS.DWORD],
            WINDOWS.BOOL,
        )
        bind(
            self.gdi,
            "GetDIBits",
            [
                handle,
                handle,
                c.c_uint,
                c.c_uint,
                c.c_void_p,
                c.POINTER(BitmapInfoHeader),
                c.c_uint,
            ],
            c.c_int,
        )
        bind(self.gdi, "DeleteObject", [handle], WINDOWS.BOOL)
        bind(self.gdi, "DeleteDC", [handle], WINDOWS.BOOL)

    def wheel_lines(self):
        lines = c.c_uint()
        # SPI_GETWHEELSCROLLLINES
        if not self.user.SystemParametersInfoW(0x68, 0, c.byref(lines), 0):
            raise OSError(c.get_last_error(), "Cannot read the wheel scroll lines")
        return lines.value

    def client(self):
        return self.verify()["window"]["client"]

    def foreground(self):
        return self.user.GetForegroundWindow() == self.window

    def activate(self):
        self._foreground()

    def _key(self, virtual, extended, up):
        flags = (KEYEVENTF_EXTENDEDKEY if extended else 0) | (
            KEYEVENTF_KEYUP if up else 0
        )
        scan = self.user.MapVirtualKeyW(virtual, 0)
        return WINDOWS.Input(
            1, WINDOWS.InputData(key=WINDOWS.KeyInput(virtual, scan, flags, 0, 0))
        )

    def key(self, name, modifiers=()):
        self._foreground()
        chord = [X11_MODIFIERS[item] for item in modifiers] + [X11_KEYS[name]]
        events = [self._key(virtual, extended, False) for virtual, extended in chord]
        events += [
            self._key(virtual, extended, True) for virtual, extended in reversed(chord)
        ]
        return self._send(events)

    def type_printable(self, text, delay_ms=10):
        if not text or len(text) > 256 or not all(" " <= ch <= "~" for ch in text):
            raise ValueError("Typed text must be bounded printable ASCII")
        self._foreground()
        for character in text:
            self._send(
                [
                    WINDOWS.Input(
                        1,
                        WINDOWS.InputData(
                            key=WINDOWS.KeyInput(0, ord(character), flags, 0, 0)
                        ),
                    )
                    for flags in (
                        KEYEVENTF_UNICODE,
                        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    )
                ]
            )
            time.sleep(delay_ms / 1000)

    def _absolute(self, x, y, viewport):
        state = self._foreground()
        left, top, width, height = state["window"]["client"]
        point = WINDOWS.Point(
            round(left + x * width / viewport[0]), round(top + y * height / viewport[1])
        )
        if not left <= point.x < left + width or not top <= point.y < top + height:
            raise RuntimeError("Pointer target is outside the owned client area")
        target = self.user.WindowFromPoint(point)
        if not target or self._owner(target) != self.host["pid"]:
            raise WINDOWS.InputUnavailable(
                "Another window covers the requested owned pointer target"
            )
        screen = [self.user.GetSystemMetrics(index) for index in (76, 77, 78, 79)]
        dx = round((point.x - screen[0]) * 65535 / (screen[2] - 1))
        dy = round((point.y - screen[1]) * 65535 / (screen[3] - 1))
        return state, point, dx, dy

    def scroll(self, x, y, viewport, notches, repeat, delay_ms):
        """`notches` wheel steps per event: positive scrolls up, as X11 button 4."""
        state, point, dx, dy = self._absolute(x, y, viewport)
        client = state["window"]["client"]
        move = WINDOWS.Input(
            0,
            WINDOWS.InputData(
                mouse=WINDOWS.MouseInput(
                    dx, dy, 0, MOUSEEVENTF_MOVE_ABSOLUTE_VIRTUAL, 0, 0
                )
            ),
        )
        self._send([move], point, client)
        data = (notches * WHEEL_DELTA) & 0xFFFFFFFF
        for _ in range(repeat):
            wheel = WINDOWS.Input(
                0,
                WINDOWS.InputData(
                    mouse=WINDOWS.MouseInput(0, 0, data, MOUSEEVENTF_WHEEL, 0, 0)
                ),
            )
            self._send([wheel], point, client)
            time.sleep(delay_ms / 1000)

    def resize(self, width, height):
        state = self._foreground()
        outer, inner = WINDOWS.Rect(), WINDOWS.Rect()
        if not self.user.GetWindowRect(self.window, c.byref(outer)) or not (
            self.user.GetClientRect(self.window, c.byref(inner))
        ):
            raise RuntimeError("Owned window geometry is unavailable")
        extra_width = (outer.right - outer.left) - (inner.right - inner.left)
        extra_height = (outer.bottom - outer.top) - (inner.bottom - inner.top)
        # SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
        if not self.user.SetWindowPos(
            self.window,
            None,
            0,
            0,
            width + extra_width,
            height + extra_height,
            0x2 | 0x4 | 0x10,
        ):
            raise OSError(c.get_last_error(), "SetWindowPos failed")
        deadline = time.monotonic() + 3
        while self.client()[2:] != [width, height]:
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"Client area stayed {self.client()[2:]} after resizing from "
                    f"{state['window']['client'][2:]} to {[width, height]}"
                )
            time.sleep(0.01)

    def os_close(self):
        self._foreground()
        if not self.user.PostMessageW(self.window, WM_SYSCOMMAND, SC_CLOSE, 0):
            raise OSError(c.get_last_error(), "Cannot post the system Close command")

    def capture(self, path):
        self._foreground()
        left, top, width, height = self.client()
        screen = self.user.GetDC(None)
        if not screen:
            raise OSError(c.get_last_error(), "Cannot read the desktop")
        memory = bitmap = previous = None
        try:
            memory = self.gdi.CreateCompatibleDC(screen)
            bitmap = self.gdi.CreateCompatibleBitmap(screen, width, height)
            if not memory or not bitmap:
                raise OSError(c.get_last_error(), "Cannot allocate a capture bitmap")
            previous = self.gdi.SelectObject(memory, bitmap)
            # SRCCOPY | CAPTUREBLT
            if not self.gdi.BitBlt(
                memory, 0, 0, width, height, screen, left, top, 0x00CC0020 | 0x40000000
            ):
                raise OSError(c.get_last_error(), "Cannot copy the client pixels")
            self.gdi.SelectObject(memory, previous)
            previous = None
            header = BitmapInfoHeader(
                c.sizeof(BitmapInfoHeader), width, -height, 1, 32, 0, 0, 0, 0, 0, 0
            )
            pixels = c.create_string_buffer(width * height * 4)
            if (
                self.gdi.GetDIBits(
                    memory, bitmap, 0, height, pixels, c.byref(header), 0
                )
                != height
            ):
                raise OSError(c.get_last_error(), "Cannot read the client pixels")
        finally:
            if previous:
                self.gdi.SelectObject(memory, previous)
            if bitmap:
                self.gdi.DeleteObject(bitmap)
            if memory:
                self.gdi.DeleteDC(memory)
            self.user.ReleaseDC(None, screen)
        # The window must still be the foreground owned client after the copy.
        if not self.foreground():
            raise WINDOWS.InputUnavailable("Native foreground changed during capture")
        png(path, width, height, pixels.raw)

    def host_exited(self):
        return (
            self.host is not None
            and self.kernel.WaitForSingleObject(self.host["handle"], 0) == 0
        )


class WindowsCommands:
    """The scenarios' X11 command words, carried out on the owned Windows window."""

    def __init__(self, windows_input, title, viewport, image):
        self.input, self.title, self.viewport, self.image = (
            windows_input,
            title,
            viewport,
            image,
        )
        self.window = None
        self.log = []

    def observe(self):
        state = self.input.observe(self.title)
        if state is None:
            raise RuntimeError("The owned Windows window is no longer observable")
        if self.window is not None and state["window"]["id"] != self.window:
            raise RuntimeError("The owned Windows window handle changed")
        return state

    def target(self, window):
        if str(window) != self.window:
            raise RuntimeError("Input addressed a window this driver does not own")

    def run(self, command, timeout=3):
        if command[:1] == ["convert"]:
            return EVIDENCE.run([self.image, *command[1:]], timeout=max(timeout, 10))
        if command[:1] != ["xdotool"] or len(command) < 2:
            raise RuntimeError(f"No Windows equivalent for {command[:2]}")
        verb, arguments = command[1], command[2:]
        self.log.append([verb, *arguments[:8]])
        if verb == "getwindowfocus":
            self.observe()
            return self.window if self.input.foreground() else "0"
        if verb == "getwindowpid":
            return str(self.observe()["host"]["pid"])
        if verb == "getwindowgeometry" and arguments[:1] == ["--shell"]:
            self.target(arguments[1])
            x, y, width, height = self.observe()["window"]["client"]
            return "\n".join(
                (
                    f"WINDOW={self.window}",
                    f"X={x}",
                    f"Y={y}",
                    f"WIDTH={width}",
                    f"HEIGHT={height}",
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
            self.input.resize(int(arguments[2]), int(arguments[3]))
            return ""
        if verb == "windowactivate":
            self.input.activate()
            return ""
        raise RuntimeError(f"No Windows equivalent for xdotool {verb}")

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
            # X11 buttons 4 and 5 are one wheel notch up and down.
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
            self.input.os_close()
            return ""
        *modifiers, name = combination.split("+")
        if name not in X11_KEYS or any(item not in X11_MODIFIERS for item in modifiers):
            raise RuntimeError(f"Unsupported key {combination}")
        self.input.key(name, modifiers)
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
    if platform.system() != "Windows":
        parser.error("This driver requires Windows")
    if not command or not host.is_absolute() or not host.is_file():
        parser.error("Supply a fixture command and absolute prebuilt BUN_NATIVE_HOST")
    image = image_tool()
    if image is None:
        raise SystemExit("Workspace pixel checks require ImageMagick 7 (magick)")
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
        "platform": "windows",
        "mode": args.mode,
        "host": {"path": str(host), **DIAGNOSTICS.fingerprint(host)},
        "command": command,
        "system": {
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "windows": platform.version(),
        },
        "sourceFiles": sources,
        "scope": "Actual GPUI host on Windows driven by SendInput pointer, wheel and key events, SetWindowPos resize and the system Close command on the owned window. The scenario modules and their native paint, layout and pixel assertions are the Linux ones, unchanged.",
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
    threads = []
    app = None
    windows_input = None
    commands = None
    expired = threading.Event()
    application_log = EVIDENCE.EventLog(output / "application.jsonl", nonce)
    native_log = EVIDENCE.EventLog(output / "native.jsonl", nonce)

    def application_records():
        return application_log.read()

    def native_records():
        return native_log.read()

    def wait_for(predicate, description, timeout=10):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if expired.is_set():
                raise RuntimeError(f"The run deadline passed before {description}")
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
        commands.observe()

    def capture(window, name):
        commands.target(window)
        windows_input.capture(output / name)
        size = EVIDENCE.run(
            [image, str(output / name), "-format", "%w %h", "info:"], timeout=10
        ).split()
        if [int(value) for value in size] != viewport():
            raise RuntimeError(f"Captured {size} differs from the native viewport")

    def deadline():
        expired.set()
        if app is not None and app.poll() is None:
            app.terminate()

    watchdog = threading.Timer(240, deadline)
    watchdog.daemon = True
    watchdog.start()
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
        windows_input = WorkspaceInput(app.pid, host)
        commands = WindowsCommands(windows_input, title, viewport, image)
        state = wait_for(
            lambda: windows_input.observe(title), "owned visible native window"
        )
        commands.window = state["window"]["id"]
        report["window"] = state["window"]
        report["desktop"] = state["desktop"]
        report["wheelScrollLines"] = windows_input.wheel_lines()
        if report["wheelScrollLines"] != 3:
            raise RuntimeError(
                "The wheel scrolls "
                f"{report['wheelScrollLines']} lines per notch; the scenarios expect 3"
            )
        client = state["window"]["client"]
        if client[2:] != SIZES[args.scenario]:
            raise RuntimeError(
                f"The window opened with client {client[2:]}, fixture "
                f"{SIZES[args.scenario]}"
            )
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
        windows_input.activate()
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
        wait_for(windows_input.host_exited, "native host exit", 5)
        report["hostExited"] = True
        if {
            relative: DIAGNOSTICS.fingerprint(ROOT / relative) for relative in SOURCES
        } != sources or DIAGNOSTICS.fingerprint(host) != {
            key: report["host"][key] for key in ("sha256", "bytes")
        }:
            raise RuntimeError(
                "Source or native artifact changed during the workspace run"
            )
        report["status"] = "passed"
    except WINDOWS.InputUnavailable as error:
        report["status"] = "unavailable"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    except Exception as error:
        LOGGER.exception("Windows workspace scenario failed")
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        if commands is not None and (output / "failure.png").exists() is False:
            try:
                windows_input.capture(output / "failure.png")
            except Exception:
                LOGGER.exception("Failure screenshot was not captured")
    finally:
        watchdog.cancel()
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
        if windows_input is not None:
            if windows_input.host is not None and not windows_input.host_exited():
                report["status"] = "failed"
                report.setdefault(
                    "error",
                    {"type": "RuntimeError", "message": "The native host survived"},
                )
            windows_input.close()
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
