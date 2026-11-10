"""Independent AT-SPI client for the isolated native qualification sessions.

`enable` turns on the session accessibility bus as a screen reader would.
`dump TITLE` waits for the owned window and prints its accessible subtree as
JSON in pre-order; each entry's `depth` is its distance below the window, and
text entries carry their selection and each character's window extents.
`act TITLE ROLE NAME ACTION [ARGS...]` performs one request as an assistive
technology would, on the first node with that role and name (an entry is
matched by its text): `click` (the node's AT-SPI action), `focus`
(Component.grab_focus), `value N` (Value.set_current_value), `caret N`
(Text.set_caret_offset) or `select START END` (Text.set_selection).
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


def describe(node: Atspi.Accessible, depth: int) -> dict:
    entry = {
        "role": node.get_role().value_nick,
        "name": node.get_name() or "",
        "states": states(node),
        "depth": depth,
    }
    value = node.get_value_iface()
    if value is not None:
        entry["value"] = {
            "current": Atspi.Value.get_current_value(value),
            "minimum": Atspi.Value.get_minimum_value(value),
            "maximum": Atspi.Value.get_maximum_value(value),
        }
    text = node.get_text_iface()
    if text is not None:
        entry["text"] = Atspi.Text.get_text(
            text, 0, Atspi.Text.get_character_count(text)
        )
        entry["caret"] = Atspi.Text.get_caret_offset(text)
        entry["selections"] = [
            [span.start_offset, span.end_offset]
            for span in (
                Atspi.Text.get_selection(text, index)
                for index in range(Atspi.Text.get_n_selections(text))
            )
        ]
        count = min(Atspi.Text.get_character_count(text), 64)
        entry["extents"] = [
            rect_list(
                Atspi.Text.get_character_extents(text, offset, Atspi.CoordType.WINDOW)
            )
            for offset in range(count)
        ]
    return entry


def rect_list(rect: Atspi.Rect) -> list[int]:
    return [rect.x, rect.y, rect.width, rect.height]


def walk(
    node: Atspi.Accessible,
    found: list[dict],
    depth: int = 0,
    nodes: list[Atspi.Accessible] | None = None,
) -> None:
    if depth > 64 or len(found) > 512:
        raise RuntimeError("accessible tree exceeds the bounded fixture size")
    found.append(describe(node, depth))
    if nodes is not None:
        nodes.append(node)
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            walk(child, found, depth + 1, nodes)


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


def subtree(title: str) -> tuple[list[dict], list[Atspi.Accessible]]:
    Atspi.init()
    deadline = time.monotonic() + 10
    while True:
        window = find_window(title)
        if window is not None:
            found: list[dict] = []
            nodes: list[Atspi.Accessible] = []
            walk(window, found, 0, nodes)
            # Wait for the first real frame: more than the window node itself.
            if len(found) > 1:
                return found, nodes
        if time.monotonic() > deadline:
            raise SystemExit(f"no accessible window named {title!r}")
        time.sleep(0.1)


def dump(title: str) -> None:
    found, _ = subtree(title)
    print(json.dumps({"window": title, "roles": found[1:]}, ensure_ascii=False))


def act(title: str, role: str, name: str, action: str, args: list[str]) -> None:
    found, nodes = subtree(title)
    matches = [
        node
        for entry, node in zip(found, nodes)
        if entry["role"] == role
        and (entry["name"] == name or entry.get("text") == name)
    ]
    if not matches:
        raise SystemExit(f"no {role} named {name!r}")
    node = matches[0]
    if action == "click":
        actions = node.get_action_iface()
        names = [
            Atspi.Action.get_action_name(actions, index)
            for index in range(Atspi.Action.get_n_actions(actions))
        ]
        done = Atspi.Action.do_action(actions, names.index("click"))
    elif action == "focus":
        done = Atspi.Component.grab_focus(node.get_component_iface())
    elif action == "value":
        done = Atspi.Value.set_current_value(node.get_value_iface(), float(args[0]))
    elif action == "caret":
        done = Atspi.Text.set_caret_offset(node.get_text_iface(), int(args[0]))
    elif action == "select":
        done = Atspi.Text.set_selection(
            node.get_text_iface(), 0, int(args[0]), int(args[1])
        )
    else:
        raise SystemExit(f"unknown action {action!r}")
    print(json.dumps({"role": role, "name": name, "action": action, "done": done}))


if __name__ == "__main__":
    if sys.argv[1:] == ["enable"]:
        enable()
    elif len(sys.argv) == 3 and sys.argv[1] == "dump":
        dump(sys.argv[2])
    elif len(sys.argv) >= 6 and sys.argv[1] == "act":
        act(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6:])
    else:
        raise SystemExit(
            "usage: atspi-probe.py enable | dump TITLE | act TITLE ROLE NAME ACTION [ARGS]"
        )
