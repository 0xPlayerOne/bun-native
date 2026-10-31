"""Thin User32 controller for the explicitly launched app's native child.

No input is considered delivered here. The shared controller must independently
observe matching native/Bun events and paint. This module never changes desktop
security settings, attaches input queues, or targets a process by title alone.

SDK contracts:
https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput
https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-userobjectflags
https://learn.microsoft.com/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w
"""

import ctypes as c
from pathlib import Path
import time


DWORD = c.c_uint32
LONG = c.c_int32
WORD = c.c_uint16
HANDLE = c.c_void_p
BOOL = c.c_int32
ULONG_PTR = c.c_size_t


class InputUnavailable(RuntimeError):
    """The current desktop cannot safely deliver the requested OS input."""


class ProcessEntry(c.Structure):
    _fields_ = [
        ("size", DWORD),
        ("usage", DWORD),
        ("pid", DWORD),
        ("heap", ULONG_PTR),
        ("module", DWORD),
        ("threads", DWORD),
        ("parent", DWORD),
        ("priority", LONG),
        ("flags", DWORD),
        ("image", WORD * 260),
    ]


class FileTime(c.Structure):
    _fields_ = [("low", DWORD), ("high", DWORD)]


class UserObjectFlags(c.Structure):
    _fields_ = [("inherit", BOOL), ("reserved", BOOL), ("flags", DWORD)]


class Point(c.Structure):
    _fields_ = [("x", LONG), ("y", LONG)]


class Rect(c.Structure):
    _fields_ = [("left", LONG), ("top", LONG), ("right", LONG), ("bottom", LONG)]


class MouseInput(c.Structure):
    _fields_ = [
        ("dx", LONG),
        ("dy", LONG),
        ("data", DWORD),
        ("flags", DWORD),
        ("time", DWORD),
        ("extra", ULONG_PTR),
    ]


class KeyInput(c.Structure):
    _fields_ = [
        ("key", WORD),
        ("scan", WORD),
        ("flags", DWORD),
        ("time", DWORD),
        ("extra", ULONG_PTR),
    ]


class InputData(c.Union):
    _fields_ = [("mouse", MouseInput), ("key", KeyInput)]


class Input(c.Structure):
    _fields_ = [("kind", DWORD), ("data", InputData)]


class WindowsInput:
    def __init__(self, app_pid, host):
        if (
            type(app_pid) is not int
            or not 0 < app_pid <= 0xFFFFFFFF
            or not Path(host).is_absolute()
        ):
            raise ValueError(
                "An owned application PID and absolute host path are required"
            )
        if (
            c.sizeof(HANDLE) != 8
            or c.sizeof(ProcessEntry) != 568
            or c.sizeof(Input) != 40
        ):
            raise InputUnavailable(
                "The Windows controller requires the verified x64 ABI"
            )
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        self.user = c.WinDLL("user32", use_last_error=True)
        self.dwm = c.WinDLL("dwmapi", use_last_error=True)
        self.handles = []
        self.previous_dpi = None
        self.host_path = Path(host).resolve()
        self.host = None
        self.window = None
        self._bind()
        try:
            self.app = self._open_process(app_pid)
            self.previous_dpi = self.user.SetThreadDpiAwarenessContext(HANDLE(-4))
            if not self.previous_dpi:
                raise InputUnavailable(
                    "Cannot use per-monitor-aware window coordinates"
                )
            self._desktop()
        except BaseException:
            self.close()
            raise

    def _bind(self):
        def bind(library, name, arguments, result):
            function = getattr(library, name)
            function.argtypes = arguments
            function.restype = result

        bind(self.kernel, "OpenProcess", [DWORD, BOOL, DWORD], HANDLE)
        bind(self.kernel, "CloseHandle", [HANDLE], BOOL)
        bind(self.kernel, "WaitForSingleObject", [HANDLE, DWORD], DWORD)
        bind(self.kernel, "GetCurrentThreadId", [], DWORD)
        bind(
            self.kernel, "GetProcessTimes", [HANDLE, *([c.POINTER(FileTime)] * 4)], BOOL
        )
        bind(
            self.kernel,
            "QueryFullProcessImageNameW",
            [HANDLE, DWORD, c.c_wchar_p, c.POINTER(DWORD)],
            BOOL,
        )
        bind(self.kernel, "CreateToolhelp32Snapshot", [DWORD, DWORD], HANDLE)
        for name in ("Process32FirstW", "Process32NextW"):
            bind(self.kernel, name, [HANDLE, c.POINTER(ProcessEntry)], BOOL)
        self.window_callback = c.WINFUNCTYPE(BOOL, HANDLE, c.c_ssize_t)
        bind(self.user, "EnumWindows", [self.window_callback, c.c_ssize_t], BOOL)
        bind(self.user, "GetWindowThreadProcessId", [HANDLE, c.POINTER(DWORD)], DWORD)
        for name in ("IsWindow", "IsWindowVisible", "IsIconic", "SetForegroundWindow"):
            bind(self.user, name, [HANDLE], BOOL)
        bind(self.user, "GetForegroundWindow", [], HANDLE)
        bind(self.user, "GetWindowTextW", [HANDLE, c.c_wchar_p, c.c_int], c.c_int)
        bind(self.user, "GetClientRect", [HANDLE, c.POINTER(Rect)], BOOL)
        bind(self.user, "ClientToScreen", [HANDLE, c.POINTER(Point)], BOOL)
        bind(self.user, "WindowFromPoint", [Point], HANDLE)
        bind(self.user, "GetAsyncKeyState", [c.c_int], c.c_int16)
        bind(self.user, "GetSystemMetrics", [c.c_int], c.c_int)
        bind(self.user, "SendInput", [c.c_uint, c.POINTER(Input), c.c_int], c.c_uint)
        bind(self.user, "SetThreadDpiAwarenessContext", [HANDLE], HANDLE)
        bind(self.user, "GetProcessWindowStation", [], HANDLE)
        bind(self.user, "GetThreadDesktop", [DWORD], HANDLE)
        bind(self.user, "OpenInputDesktop", [DWORD, BOOL, DWORD], HANDLE)
        bind(self.user, "CloseDesktop", [HANDLE], BOOL)
        bind(
            self.user,
            "GetUserObjectInformationW",
            [HANDLE, c.c_int, c.c_void_p, DWORD, c.POINTER(DWORD)],
            BOOL,
        )
        bind(
            self.dwm,
            "DwmGetWindowAttribute",
            [HANDLE, DWORD, c.c_void_p, DWORD],
            c.c_int32,
        )

    def _desktop(self):
        station = self.user.GetProcessWindowStation()
        flags = UserObjectFlags()
        needed = DWORD()
        if (
            not station
            or not self.user.GetUserObjectInformationW(
                station, 1, c.byref(flags), c.sizeof(flags), c.byref(needed)
            )
            or not flags.flags & 1
        ):
            raise InputUnavailable(
                "The Windows process has no visible interactive window station"
            )

        def name(handle):
            value = c.create_unicode_buffer(257)
            if not handle or not self.user.GetUserObjectInformationW(
                handle, 2, value, c.sizeof(value), c.byref(needed)
            ):
                raise InputUnavailable(
                    "The Windows input desktop identity is unavailable"
                )
            return value.value

        # These are borrowed handles; only OpenInputDesktop's result is closed.
        current = self.user.GetThreadDesktop(self.kernel.GetCurrentThreadId())
        active = self.user.OpenInputDesktop(0, False, 1)  # DESKTOP_READOBJECTS
        if not active:
            raise InputUnavailable("The active Windows input desktop cannot be read")
        try:
            desktop = name(current)
            if desktop != name(active):
                raise InputUnavailable(
                    "The controller is not on the active Windows input desktop"
                )
            return {
                "windowStation": name(station),
                "desktop": desktop,
                "visibleSurface": True,
            }
        finally:
            if not self.user.CloseDesktop(active):
                raise RuntimeError(
                    "The Windows input desktop query handle could not be released"
                )

    def _identity(self, handle, pid):
        times = [FileTime() for _ in range(4)]
        size = DWORD(32768)
        image = c.create_unicode_buffer(size.value)
        if (
            self.kernel.WaitForSingleObject(handle, 0) != 258
            or not self.kernel.GetProcessTimes(
                handle, *(c.byref(item) for item in times)
            )
            or not self.kernel.QueryFullProcessImageNameW(
                handle, 0, image, c.byref(size)
            )
        ):
            raise RuntimeError(
                "Owned Windows process exited or its identity is unavailable"
            )
        return {
            "pid": pid,
            "created": str((times[0].high << 32) | times[0].low),
            "image": str(Path(image.value).resolve()),
        }

    def _open_process(self, pid):
        handle = self.kernel.OpenProcess(0x1000 | 0x100000, False, pid)
        if not handle:
            raise OSError(c.get_last_error(), "Cannot query owned Windows process")
        try:
            process = {"handle": handle, **self._identity(handle, pid)}
        except BaseException:
            self.kernel.CloseHandle(handle)
            raise
        self.handles.append(handle)
        return process

    def _verify_process(self, process):
        current = self._identity(process["handle"], process["pid"])
        if any(current[key] != process[key] for key in current):
            raise RuntimeError("Owned Windows process identity changed")

    def _children(self):
        snapshot = self.kernel.CreateToolhelp32Snapshot(2, 0)
        if snapshot in (None, HANDLE(-1).value):
            raise OSError(c.get_last_error(), "Cannot inspect child process ownership")
        try:
            entry = ProcessEntry()
            entry.size = c.sizeof(entry)
            found = []
            valid = self.kernel.Process32FirstW(snapshot, c.byref(entry))
            for _ in range(65_536):
                if not valid:
                    if c.get_last_error() != 18:
                        raise OSError(
                            c.get_last_error(), "Process snapshot was incomplete"
                        )
                    return found
                if entry.parent == self.app["pid"]:
                    found.append(entry.pid)
                valid = self.kernel.Process32NextW(snapshot, c.byref(entry))
            raise RuntimeError("Windows process snapshot exceeded its bounded scan")
        finally:
            self.kernel.CloseHandle(snapshot)

    def _owner(self, window):
        pid = DWORD()
        if not self.user.GetWindowThreadProcessId(window, c.byref(pid)):
            raise RuntimeError("Owned native window is no longer available")
        return pid.value

    def observe(self, title):
        self._verify_process(self.app)
        self._desktop()
        if self.host is None:
            matches = []
            for pid in self._children():
                try:
                    candidate = self._open_process(pid)
                except (OSError, RuntimeError):
                    continue
                # Toolhelp retains the numeric parent PID even after that
                # parent exits. An older orphan must not become "our child"
                # when Windows later reuses that PID for this application.
                if Path(candidate["image"]) == self.host_path and int(
                    candidate["created"]
                ) >= int(self.app["created"]):
                    matches.append(candidate)
                else:
                    self.kernel.CloseHandle(candidate["handle"])
                    self.handles.remove(candidate["handle"])
            if len(matches) > 1:
                raise RuntimeError(
                    "Multiple native children match the expected executable"
                )
            if not matches:
                return None
            self.host = matches[0]
        self._verify_process(self.host)
        if self.host["pid"] not in self._children():
            raise RuntimeError(
                "Native executable is no longer the launched app's child"
            )
        windows = []
        failures = []

        def collect(window, _data):
            try:
                pid = DWORD()
                # An unrelated window may disappear while EnumWindows runs.
                if (
                    not self.user.GetWindowThreadProcessId(window, c.byref(pid))
                    or pid.value != self.host["pid"]
                ):
                    return True
                if self._visible_title(window) == title:
                    windows.append(window)
                return True
            except BaseException as error:
                # Exceptions must not escape a C callback and be discarded by
                # ctypes; report them after EnumWindows returns.
                failures.append(error)
                return False

        success = self.user.EnumWindows(self.window_callback(collect), 0)
        if failures:
            raise failures[0]
        if not success:
            raise OSError(c.get_last_error(), "Cannot enumerate native windows")
        if len(windows) > 1:
            raise RuntimeError("Multiple owned visible windows match the fixture")
        if not windows:
            return None
        self.window = windows[0]
        self.title = title
        return self.verify()

    def _visible_title(self, window):
        if not self.user.IsWindowVisible(window) or self.user.IsIconic(window):
            return None
        cloaked = DWORD()
        result = self.dwm.DwmGetWindowAttribute(
            window, 14, c.byref(cloaked), c.sizeof(cloaked)
        )
        if result != 0 or cloaked.value != 0:
            return None
        name = c.create_unicode_buffer(257)
        self.user.GetWindowTextW(window, name, len(name))
        return name.value

    def verify(self):
        desktop = self._desktop()
        self._verify_process(self.app)
        self._verify_process(self.host)
        if (
            not self.user.IsWindow(self.window)
            or self._owner(self.window) != self.host["pid"]
        ):
            raise RuntimeError("Native window ownership changed")
        if self._visible_title(self.window) != self.title:
            raise InputUnavailable("Native visibility or window title changed")
        rect = Rect()
        origin = Point()
        if not self.user.GetClientRect(
            self.window, c.byref(rect)
        ) or not self.user.ClientToScreen(self.window, c.byref(origin)):
            raise RuntimeError("Native client geometry is unavailable")
        width, height = rect.right - rect.left, rect.bottom - rect.top
        if not 0 < width <= 32768 or not 0 < height <= 32768:
            raise RuntimeError("Native client geometry is outside the test bound")
        return {
            "method": "Toolhelp32 + process creation identity + EnumWindows",
            "desktop": desktop,
            "application": {
                key: value for key, value in self.app.items() if key != "handle"
            },
            "host": {key: value for key, value in self.host.items() if key != "handle"},
            "window": {
                "id": str(self.window),
                "title": self.title,
                "visible": True,
                "client": [origin.x, origin.y, width, height],
            },
        }

    def _foreground(self):
        state = self.verify()
        self.user.SetForegroundWindow(self.window)
        deadline = time.monotonic() + 1
        while self.user.GetForegroundWindow() != self.window:
            if time.monotonic() >= deadline:
                raise InputUnavailable(
                    "The owned native window cannot become foreground on this desktop"
                )
            time.sleep(0.01)
        for key in (0x10, 0x11, 0x12, 0x5B, 0x5C, 0x01):
            if self.user.GetAsyncKeyState(key) & 0x8000:
                raise InputUnavailable(
                    "An external modifier or pointer button is held; no input was injected"
                )
        return state

    def _send(self, events, pointer=None, client=None):
        state = self.verify()
        if self.user.GetForegroundWindow() != self.window:
            raise InputUnavailable("Native foreground changed before input")
        if pointer is not None and (
            state["window"]["client"] != client
            or self._owner(self.user.WindowFromPoint(pointer)) != self.host["pid"]
        ):
            raise InputUnavailable("Owned pointer target changed before input")
        values = (Input * len(events))(*events)
        count = self.user.SendInput(len(values), values, c.sizeof(Input))
        if count != len(values):
            release = None
            if 0 < count < len(events):
                last = events[count - 1]
                if last.kind == 1 and not last.data.key.flags & 2:
                    key = last.data.key
                    release = Input(
                        1,
                        InputData(
                            key=KeyInput(key.key, key.scan, key.flags | 2, 0, key.extra)
                        ),
                    )
                elif last.kind == 0 and last.data.mouse.flags & 2:
                    release = Input(0, InputData(mouse=MouseInput(0, 0, 0, 4, 0, 0)))
            released = None
            if release is not None:
                # Undo only the down event reported as inserted by this call.
                # No modifier or externally held key is cleared. A partial
                # insertion remains a failed capability check regardless.
                released = (
                    self.user.SendInput(1, c.byref(release), c.sizeof(Input)) == 1
                )
            raise InputUnavailable(
                f"SendInput inserted {count}/{len(values)} events; own partial-down release={released}; desktop/UIPI capability is unverified"
            )
        if self.user.GetForegroundWindow() != self.window:
            raise RuntimeError("Native foreground changed during input")
        return {
            "method": "Windows SendInput",
            "insertedEvents": count,
            "delivery": "requires independent native/Bun evidence",
        }

    def click(self, x, y, viewport):
        state = self._foreground()
        left, top, width, height = state["window"]["client"]
        point = Point(
            round(left + x * width / viewport[0]), round(top + y * height / viewport[1])
        )
        if not left <= point.x < left + width or not top <= point.y < top + height:
            raise RuntimeError("Pointer target is outside the owned client area")
        target = self.user.WindowFromPoint(point)
        if not target or self._owner(target) != self.host["pid"]:
            raise InputUnavailable(
                "Another window covers the requested owned pointer target"
            )
        screen = [self.user.GetSystemMetrics(index) for index in (76, 77, 78, 79)]
        if screen[2] <= 1 or screen[3] <= 1:
            raise InputUnavailable(
                "The interactive desktop has no usable virtual screen"
            )
        dx = round((point.x - screen[0]) * 65535 / (screen[2] - 1))
        dy = round((point.y - screen[1]) * 65535 / (screen[3] - 1))
        if not 0 <= dx <= 65535 or not 0 <= dy <= 65535:
            raise InputUnavailable(
                "Owned pointer target is outside the virtual desktop"
            )
        events = [
            Input(0, InputData(mouse=MouseInput(dx, dy, 0, flags, 0, 0)))
            for flags in (0xC001, 0xC002, 0xC004)
        ]
        return {
            **self._send(events, point, state["window"]["client"]),
            "screenPoint": [point.x, point.y],
            "client": state["window"]["client"],
        }

    def tab(self):
        self._foreground()
        return self._send(
            [Input(1, InputData(key=KeyInput(9, 0, flags, 0, 0))) for flags in (0, 2)]
        )

    def type_text(self, text):
        if (
            not text
            or len(text) > 64
            or not all(character in "0123456789abcdef" for character in text)
        ):
            raise ValueError(
                "OS text injection accepts only a bounded hexadecimal run nonce"
            )
        self._foreground()
        events = [
            Input(1, InputData(key=KeyInput(0, ord(character), flags, 0, 0)))
            for character in text
            for flags in (4, 6)
        ]
        return self._send(events)

    def close(self):
        failed = False
        if self.previous_dpi:
            failed = not self.user.SetThreadDpiAwarenessContext(self.previous_dpi)
            self.previous_dpi = None
        for handle in reversed(self.handles):
            failed = not self.kernel.CloseHandle(handle) or failed
        self.handles.clear()
        if failed:
            raise RuntimeError(
                "The Windows controller could not release every owned handle/DPI context"
            )
