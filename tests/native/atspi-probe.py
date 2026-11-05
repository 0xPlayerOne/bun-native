"""Independent AT-SPI client for the isolated native text qualification session.

`enable` turns on the session accessibility bus as a screen reader would.
`dump TITLE` waits for the owned window and prints its accessible subtree as JSON.
Run with a system Python that provides PyGObject and the Atspi typelib.
"""

import json
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib


def enable() -> None:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    for name in ("IsEnabled", "ScreenReaderEnabled"):
        bus.call_sync(
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.freedesktop.DBus.Properties",
            "Set",
            GLib.Variant("(ssv)", ("org.a11y.Status", name, GLib.Variant("b", True))),
            None,
            Gio.DBusCallFlags.NONE,
            5_000,
            None,
        )
    print(json.dumps({"enabled": True}))


def states(node: Atspi.Accessible) -> list[str]:
    state_set = node.get_state_set()
    return sorted(
        state.value_nick
        for state in state_set.get_states()  # type: ignore[attr-defined]
    )


def describe(node: Atspi.Accessible) -> dict:
    entry = {
        "role": node.get_role().value_nick,
        "name": node.get_name() or "",
        "states": states(node),
    }
    text = node.get_text_iface()
    if text is not None:
        entry["text"] = Atspi.Text.get_text(
            text, 0, Atspi.Text.get_character_count(text)
        )
        entry["caret"] = Atspi.Text.get_caret_offset(text)
    return entry


def walk(node: Atspi.Accessible, found: list[dict], depth: int = 0) -> None:
    if depth > 64 or len(found) > 512:
        raise RuntimeError("accessible tree exceeds the bounded fixture size")
    found.append(describe(node))
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            walk(child, found, depth + 1)


def find_window(title: str) -> Atspi.Accessible | None:
    desktop = Atspi.get_desktop(0)
    for app_index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(app_index)
        if app is None:
            continue
        for index in range(app.get_child_count()):
            window = app.get_child_at_index(index)
            if window is not None and window.get_name() == title:
                return window
    return None


def dump(title: str) -> None:
    Atspi.init()
    deadline = time.monotonic() + 10
    while True:
        window = find_window(title)
        if window is not None:
            found: list[dict] = []
            walk(window, found)
            # Wait for the first real frame: more than the window node itself.
            if len(found) > 1:
                break
        if time.monotonic() > deadline:
            raise SystemExit(f"no accessible window named {title!r}")
        time.sleep(0.1)
    print(json.dumps({"window": title, "roles": found[1:]}, ensure_ascii=False))


if __name__ == "__main__":
    if sys.argv[1:] == ["enable"]:
        enable()
    elif len(sys.argv) == 3 and sys.argv[1] == "dump":
        dump(sys.argv[2])
    else:
        raise SystemExit("usage: atspi-probe.py enable | dump TITLE")
