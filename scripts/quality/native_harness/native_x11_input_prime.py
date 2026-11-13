"""Settle a fresh private Xvfb's XTest keyboard before any test input (#358).

On a fresh X server the first XTest key event switches the core keyboard's
source device to the XTest keyboard. The server then sends an
XkbNewKeyboardNotify, which Xlib reports to openbox as a MappingNotify, and
openbox ungrabs and regrabs every key binding. If that first key event is a
test's Alt+F4, the F4 press can reach the server while openbox holds no
Alt+F4 grab, so it goes to the focused application and the window never
closes. Click-only scenarios hit this, because their close shortcut is the
first key of the session.

This script, run once per session after the window manager is ready:
1. sends one Shift press and release through XTest (no window is mapped yet);
2. waits until openbox has handled every event queued before a
   _NET_REQUEST_FRAME_EXTENTS request, which it answers by setting
   _NET_FRAME_EXTENTS. Openbox handles its events in order, so the rebind for
   the keyboard switch has finished by then;
3. sends a second Shift and checks that it causes no further keyboard switch,
   so later test keys, including the close shortcut, cannot trigger a rebind.

It writes one JSON report and exits nonzero if the window manager does not
answer or the second key switches the keyboard again. It never retries.
"""

import argparse
import ctypes
import ctypes.util
import json
import select
import subprocess
import sys
import time
from pathlib import Path

CLIENT_MESSAGE = 33
PROPERTY_NOTIFY = 28
PROPERTY_CHANGE_MASK = 1 << 22
SUBSTRUCTURE_NOTIFY_MASK = 1 << 19
SUBSTRUCTURE_REDIRECT_MASK = 1 << 20
XKB_USE_CORE_KEYBOARD = 0x0100
XKB_NEW_KEYBOARD_NOTIFY = 0
XKB_NEW_KEYBOARD_NOTIFY_MASK = 1 << 0


class ClientMessage(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data", ctypes.c_long * 5),
    ]


class PropertyEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("atom", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("state", ctypes.c_int),
    ]


class XkbAnyEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("time", ctypes.c_ulong),
        ("xkb_type", ctypes.c_int),
        ("device", ctypes.c_uint),
    ]


class Event(ctypes.Union):
    _fields_ = [
        ("type", ctypes.c_int),
        ("client", ClientMessage),
        ("property", PropertyEvent),
        ("xkb", XkbAnyEvent),
        ("pad", ctypes.c_long * 24),
    ]


def load_xlib():
    path = ctypes.util.find_library("X11")
    if not path:
        raise RuntimeError("libX11 is unavailable")
    xlib = ctypes.CDLL(path)
    xlib.XOpenDisplay.restype = ctypes.c_void_p
    xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    xlib.XDefaultRootWindow.restype = ctypes.c_ulong
    xlib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    xlib.XCreateSimpleWindow.restype = ctypes.c_ulong
    xlib.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    xlib.XCreateSimpleWindow.argtypes += [ctypes.c_int] * 2 + [ctypes.c_uint] * 2
    xlib.XCreateSimpleWindow.argtypes += [ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
    xlib.XSelectInput.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_long]
    xlib.XInternAtom.restype = ctypes.c_ulong
    xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    xlib.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int]
    xlib.XSendEvent.argtypes += [ctypes.c_long, ctypes.POINTER(Event)]
    xlib.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.POINTER(Event)]
    for name in ["XPending", "XConnectionNumber", "XCloseDisplay"]:
        getattr(xlib, name).argtypes = [ctypes.c_void_p]
    xlib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    xlib.XDestroyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    xlib.XkbQueryExtension.argtypes = [ctypes.c_void_p] + [
        ctypes.POINTER(ctypes.c_int)
    ] * 5
    xlib.XkbSelectEvents.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    xlib.XkbSelectEvents.argtypes += [ctypes.c_ulong, ctypes.c_ulong]
    return xlib


class Session:
    def __init__(self, xlib):
        self.xlib = xlib
        self.display = xlib.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError("Cannot open the private X display")
        opcode, event, error = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
        major, minor = ctypes.c_int(1), ctypes.c_int(0)
        if not xlib.XkbQueryExtension(self.display, opcode, event, error, major, minor):
            raise RuntimeError("The X server has no XKB extension")
        self.xkb_event = event.value
        if not xlib.XkbSelectEvents(
            self.display,
            XKB_USE_CORE_KEYBOARD,
            XKB_NEW_KEYBOARD_NOTIFY_MASK,
            XKB_NEW_KEYBOARD_NOTIFY_MASK,
        ):
            raise RuntimeError("Cannot observe XKB keyboard switches")
        self.root = xlib.XDefaultRootWindow(self.display)
        self.window = xlib.XCreateSimpleWindow(
            self.display, self.root, 0, 0, 1, 1, 0, 0, 0
        )
        xlib.XSelectInput(self.display, self.window, PROPERTY_CHANGE_MASK)
        self.request = xlib.XInternAtom(
            self.display, b"_NET_REQUEST_FRAME_EXTENTS", False
        )
        self.extents = xlib.XInternAtom(self.display, b"_NET_FRAME_EXTENTS", False)
        xlib.XSync(self.display, False)
        self.switches = 0

    def close(self):
        self.xlib.XDestroyWindow(self.display, self.window)
        self.xlib.XCloseDisplay(self.display)

    def drain(self, until_extents, deadline):
        """Read events in server order; count switches before the WM answer."""
        descriptor = self.xlib.XConnectionNumber(self.display)
        event = Event()
        while True:
            while self.xlib.XPending(self.display):
                self.xlib.XNextEvent(self.display, ctypes.byref(event))
                if (
                    event.type == self.xkb_event
                    and event.xkb.xkb_type == XKB_NEW_KEYBOARD_NOTIFY
                ):
                    self.switches += 1
                elif (
                    until_extents
                    and event.type == PROPERTY_NOTIFY
                    and event.property.window == self.window
                    and event.property.atom == self.extents
                ):
                    return True
            if not until_extents:
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            select.select([descriptor], [], [], min(remaining, 0.1))

    def window_manager_barrier(self, deadline):
        message = Event()
        message.client.type = CLIENT_MESSAGE
        message.client.window = self.window
        message.client.message_type = self.request
        message.client.format = 32
        if not self.xlib.XSendEvent(
            self.display,
            self.root,
            False,
            SUBSTRUCTURE_REDIRECT_MASK | SUBSTRUCTURE_NOTIFY_MASK,
            ctypes.byref(message),
        ):
            raise RuntimeError("Cannot send the window manager barrier request")
        self.xlib.XSync(self.display, False)
        return self.drain(True, deadline)


def xtest_shift():
    # xdotool closes its display with XSync, so the server has processed the
    # press and release before this returns.
    subprocess.run(["xdotool", "key", "shift"], check=True, timeout=5)


def settle(session, send_key, deadline, started, report):
    """Prime the keyboard switch, wait for the WM, then prove it cannot recur."""
    send_key()
    if not session.window_manager_barrier(deadline):
        raise RuntimeError("The window manager did not answer the keyboard barrier")
    report["first_key_keyboard_switches"] = session.switches
    report["window_manager_settled_ms"] = (time.monotonic() - started) * 1000
    session.switches = 0
    send_key()
    if not session.window_manager_barrier(deadline):
        raise RuntimeError("The window manager did not answer the control barrier")
    report["control_key_keyboard_switches"] = session.switches
    if session.switches:
        raise RuntimeError(
            "A later XTest key switched the keyboard again; test keys "
            "could still race a window manager rebind"
        )


def main(argv=None, open_session=None, send_key=xtest_shift):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args(argv)
    started = time.monotonic()
    report = {
        "schema_version": 1,
        "scope": "first XTest keyboard switch settled before test input",
        "clock": "prime_monotonic_relative_ms",
    }
    status = 1
    try:
        session = (open_session or (lambda: Session(load_xlib())))()
        try:
            settle(session, send_key, started + args.timeout, started, report)
            report["status"] = "settled"
            status = 0
        finally:
            session.close()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        report.update(status="failed", error=str(error)[-2000:])
    report["duration_ms"] = (time.monotonic() - started) * 1000
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    if status:
        print(f"XTest keyboard prime failed: {report['error']}", file=sys.stderr)
    return status
