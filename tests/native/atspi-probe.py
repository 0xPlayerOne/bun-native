"""Independent AT-SPI client for the isolated native qualification sessions.

`enable` turns on the session accessibility bus as a screen reader would.
`dump TITLE` waits for the owned window and prints its accessible subtree as
JSON in pre-order; each entry's `depth` is its distance below the window, and
components carry their window extents, and text entries carry their selection
and each character's window extents.
`act TITLE ROLE NAME ACTION [ARGS...]` performs one request as an assistive
technology would, on the first node with that role and name (an entry is
matched by its text): `click` (the node's AT-SPI action), `focus`
(Component.grab_focus), `value N` (Value.set_current_value), `caret N`
(Text.set_caret_offset) or `select START END` (Text.set_selection).
`watch SECONDS` prints `{"ready": true}` once its listeners are registered and
then one JSON line per AT-SPI event a screen reader listens to (value and
name changes, children added or removed, state changes, announcements),
naming the source's role and name and the event's detail and data (and, for a
value change, the source's value when the event arrives), until
SECONDS pass or its input closes.
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
    component = node.get_component_iface()
    if component is not None:
        entry["bounds"] = rect_list(
            Atspi.Component.get_extents(component, Atspi.CoordType.WINDOW)
        )
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


WATCHED = (
    "object:property-change:accessible-value",
    "object:property-change:accessible-name",
    "object:children-changed",
    "object:state-changed",
    "object:announcement",
)


def event_data(value: object) -> object:
    if isinstance(value, Atspi.Accessible):
        try:
            return {"role": value.get_role().value_nick, "name": value.get_name() or ""}
        except GLib.Error:
            return {"defunct": True}
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    return str(value)


def watch(seconds: float) -> None:
    Atspi.init()
    loop = GLib.MainLoop()

    def on_event(event: Atspi.Event) -> None:
        try:
            source = {
                "role": event.source.get_role().value_nick,
                "name": event.source.get_name() or "",
            }
        except GLib.Error:
            source = {"defunct": True}
        line = {
            "type": event.type,
            "source": source,
            "detail1": event.detail1,
            "detail2": event.detail2,
            "data": event_data(event.any_data),
        }
        # libatspi does not carry a value change's number in any_data; read
        # the source's value as the event is delivered.
        if event.type == "object:property-change:accessible-value":
            try:
                value = event.source.get_value_iface()
                if value is not None:
                    line["current"] = Atspi.Value.get_current_value(value)
            except GLib.Error:
                pass
        print(json.dumps(line, ensure_ascii=False), flush=True)

    listener = Atspi.EventListener.new(on_event)
    for name in WATCHED:
        listener.register(name)
    # Stop when the driver closes stdin or the bound passes.
    GLib.io_add_watch(sys.stdin, GLib.IO_HUP | GLib.IO_IN, lambda *_: loop.quit() or False)
    GLib.timeout_add(int(seconds * 1000), loop.quit)
    print(json.dumps({"ready": True}), flush=True)
    loop.run()


if __name__ == "__main__":
    if sys.argv[1:] == ["enable"]:
        enable()
    elif len(sys.argv) == 3 and sys.argv[1] == "dump":
        dump(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == "watch":
        watch(float(sys.argv[2]))
    elif len(sys.argv) >= 6 and sys.argv[1] == "act":
        act(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6:])
    else:
        raise SystemExit(
            "usage: atspi-probe.py enable | dump TITLE | watch SECONDS"
            " | act TITLE ROLE NAME ACTION [ARGS]"
        )
