"""Small OS adapters for the existing portable native smoke controller.

Only the supplied application's owned native window is addressed. Observation,
injection and application/native delivery evidence remain separate operations.
"""

import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys


HERE = Path(__file__).resolve().parent


class InputUnavailable(RuntimeError):
    """The current session cannot verify actual native input."""


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pointer_target(layout, node_id):
    """Use actual native geometry, rejecting omitted, clipped or invalid targets."""
    if not isinstance(layout, dict) or layout.get("status") != "complete":
        raise RuntimeError("Complete native geometry is required before OS input")
    viewport = layout.get("viewport")
    node = next(
        (item for item in layout.get("nodes", []) if item.get("node_id") == node_id),
        None,
    )
    if not node or not isinstance(viewport, list) or len(viewport) != 2:
        raise RuntimeError("Native pointer target is missing")
    bounds, clip = node.get("bounds"), node.get("ancestor_clip")
    if (
        not isinstance(bounds, list)
        or len(bounds) != 4
        or not isinstance(clip, list)
        or len(clip) != 4
    ):
        raise RuntimeError("Native pointer bounds are invalid")
    if any(
        type(item) not in (int, float) or not math.isfinite(item)
        for item in [*viewport, *bounds, *clip]
    ):
        raise RuntimeError("Native pointer geometry must be finite numeric data")
    if any(not 0 < item <= 32768 for item in [*viewport, *bounds[2:], *clip[2:]]):
        raise RuntimeError("Native pointer dimensions exceed their bound")
    x, y = bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2
    if not (
        0 <= x < viewport[0]
        and 0 <= y < viewport[1]
        and clip[0] <= x < clip[0] + clip[2]
        and clip[1] <= y < clip[1] + clip[3]
    ):
        raise RuntimeError("Native pointer target is clipped or outside the viewport")
    return x, y, viewport


def input_delivery(rows, cycle, nonce, *, complete=False):
    """Require every OS-generated input prefix/revision; missing data never passes."""
    selected = [
        row
        for row in rows
        if row.get("cycle") == cycle and row.get("type") in ("os-click", "os-input")
    ]
    clicks = edits = 0
    sequence = 0
    for row in selected:
        current = row.get("sequence")
        if (
            type(current) is not int
            or current <= sequence
            or type(row.get("treeRevision")) is not int
            or row["treeRevision"] != 1
        ):
            raise RuntimeError("Native input sequence or committed revision is invalid")
        sequence = current
        if row["type"] == "os-click":
            clicks += 1
            if clicks != 1 or edits or row.get("kind") != "button":
                raise RuntimeError(
                    "Native pointer activation was duplicated or misrouted"
                )
        else:
            edits += 1
            if (
                clicks != 1
                or edits > len(nonce)
                or type(row.get("revision")) is not int
                or row["revision"] != edits
                or row.get("value") != nonce[:edits]
                or row.get("kind") != "input"
            ):
                raise RuntimeError(
                    "An OS input edit was lost, duplicated, reordered or misrouted"
                )
    done = clicks == 1 and edits == len(nonce)
    if complete and not done:
        raise RuntimeError("Not every expected native OS input edit arrived")
    return {
        "complete": done,
        "clicks": clicks,
        "edits": edits,
        "lastSequence": sequence,
    }


class MacInput:
    def __init__(self, app_pid, host):
        self.app_pid, self.host = app_pid, str(host)
        self.helper = Path(os.environ.get("BUN_NATIVE_PLATFORM_HELPER", ""))
        if not self.helper.is_absolute() or not self.helper.is_file():
            raise InputUnavailable("An explicit prebuilt macOS SDK helper is required")
        self.title = ""
        self.state = None
        self.application = self._call("identity")["application"]

    def _call(self, action, **extra):
        request = {
            "action": action,
            "app_pid": self.app_pid,
            "host": self.host,
            "title": self.title,
            **extra,
        }
        result = subprocess.run(
            [str(self.helper), json.dumps(request, separators=(",", ":"))],
            capture_output=True,
            timeout=3,
        )
        if len(result.stdout) > 16384 or len(result.stderr) > 16384:
            raise RuntimeError("macOS OS helper exceeded its output bound")
        try:
            value = json.loads(result.stdout)
        except (ValueError, UnicodeError) as error:
            raise RuntimeError("macOS OS helper did not return bounded JSON") from error
        if value.get("status") == "unsupported" and result.returncode == 2:
            raise InputUnavailable(
                value.get("error", "macOS session capability is unavailable")
            )
        if result.returncode != 0 or value.get("status") not in ("ready", "not-ready"):
            raise RuntimeError(
                "macOS OS helper failed: " + str(value.get("error", result.returncode))
            )
        return value

    def observe(self, title):
        self.title = title
        value = self._call("observe")
        if value["status"] == "not-ready":
            return None
        if value.get("application") != self.application:
            raise RuntimeError("Owned macOS application identity changed")
        self.state = value
        return value

    def _input(self, action, **extra):
        if self.state is None:
            raise RuntimeError("An independently observed macOS window is required")
        available = self.state.get("postEventAccess")
        if type(available) is not bool:
            raise RuntimeError("macOS posting capability metadata is malformed")
        if not available:
            raise InputUnavailable(
                "CoreGraphics event posting permission is unavailable; no input helper was invoked and no permission was requested"
            )
        # The helper still rechecks current permission, process identity,
        # window geometry and foreground state before every permitted post.
        return self._call(action, expected=self.state, **extra)

    def click(self, x, y, viewport):
        return self._input("click", x=x, y=y, viewport=viewport)

    def tab(self):
        return self._input("tab")

    def type_text(self, text):
        return self._input("text", text=text)

    def close(self):
        # Helper commands release their own CoreFoundation objects and exit.
        pass


class LinuxInput:
    """Reuse the established X11 driver's ownership and command helpers."""

    def __init__(self, app, host, diagnostics):
        self.app, self.host, self.diagnostics = app, host, diagnostics
        self.driver = diagnostics.DRIVER
        if not self.driver.proc_identity_matches():
            raise InputUnavailable(
                "Linux process identity is unavailable in this namespace"
            )
        self.observed = {}
        self.pid = None
        self.window = None

    def _verify(self):
        self.diagnostics.require_owned_host(
            self.app, self.observed, self.pid, self.host
        )
        if (
            self.window
            and int(self.driver.run(["xdotool", "getwindowpid", self.window]))
            != self.pid
        ):
            raise RuntimeError("Owned X11 window process changed")

    def observe(self, title):
        table = self.driver.process_table()
        for row in self.driver.owned_processes(self.app.pid, table):
            if row["pid"] == self.app.pid:
                continue
            try:
                image = Path(f"/proc/{row['pid']}/exe").resolve(strict=True)
            except OSError:
                continue
            if image == self.host:
                if self.pid is not None and self.pid != row["pid"]:
                    raise RuntimeError("Multiple owned native executables match")
                self.pid = row["pid"]
                self.observed.setdefault(self.pid, row["start_ticks"])
        if self.pid is None:
            return None
        self.window = None
        self._verify()
        result = subprocess.run(
            [
                "xdotool",
                "search",
                "--onlyvisible",
                "--pid",
                str(self.pid),
                "--name",
                "^" + re.escape(title) + "$",
            ],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if result.returncode == 1 and not result.stdout.strip():
            return None
        windows = result.stdout.split()
        if result.returncode != 0 or len(windows) != 1:
            raise RuntimeError(
                "The owned X11 fixture window is ambiguous or unavailable"
            )
        self.window = windows[0]
        self._verify()
        return {
            "method": "Existing Linux process-identity helpers and owned X11 window",
            "host": {
                "pid": self.pid,
                "startTicks": self.observed[self.pid],
                "image": str(self.host),
            },
            "window": {"id": self.window, "title": title, "visible": True},
        }

    def _foreground(self):
        self._verify()
        self.driver.run(["xdotool", "windowactivate", "--sync", self.window])
        if self.driver.run(["xdotool", "getactivewindow"]) != self.window:
            raise InputUnavailable("The owned X11 window cannot become active")

    def click(self, x, y, viewport):
        self._foreground()
        geometry = dict(
            line.split("=", 1)
            for line in self.driver.run(
                ["xdotool", "getwindowgeometry", "--shell", self.window]
            ).splitlines()
        )
        x, y = (
            round(x * int(geometry["WIDTH"]) / viewport[0]),
            round(y * int(geometry["HEIGHT"]) / viewport[1]),
        )
        if not 0 <= x < int(geometry["WIDTH"]) or not 0 <= y < int(geometry["HEIGHT"]):
            raise RuntimeError("X11 pointer target is outside the owned window")
        self.driver.run(
            ["xdotool", "mousemove", "--window", self.window, str(x), str(y)]
        )
        self._verify()
        self.driver.run(["xdotool", "click", "1"])
        return {
            "method": "XTest through existing xdotool helper",
            "action": "pointer click",
            "windowPoint": [x, y],
            "delivery": "requires independent native/Bun evidence",
        }

    def tab(self):
        self._foreground()
        self.driver.run(["xdotool", "key", "--clearmodifiers", "Tab"])
        return {"method": "XTest through existing xdotool helper", "action": "Tab"}

    def type_text(self, text):
        if not re.fullmatch("[0-9a-f]{1,64}", text):
            raise ValueError(
                "OS text injection accepts only a bounded hexadecimal run nonce"
            )
        self._foreground()
        self.driver.run(
            ["xdotool", "type", "--clearmodifiers", "--delay", "10", "--", text]
        )
        return {
            "method": "XTest through existing xdotool helper",
            "action": "text",
            "characters": len(text),
        }

    def close(self):
        pass


def create(app, host, diagnostics):
    if sys.platform == "win32":
        module = load("native-platform-windows")
        try:
            driver = module.WindowsInput(app.pid, host)
        except module.InputUnavailable as error:
            raise InputUnavailable(str(error)) from error
        return driver, (module.InputUnavailable,)
    if sys.platform == "darwin":
        return MacInput(app.pid, host), (InputUnavailable,)
    if sys.platform == "linux":
        return LinuxInput(app, host, diagnostics), (InputUnavailable,)
    raise InputUnavailable(
        "No actual OS input controller is implemented for this platform"
    )
