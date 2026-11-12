"""Independent IBus panel for the isolated X11 input-method qualification.

It takes the IBus panel's bus name, the role ibus-ui-gtk3 plays on a desktop,
and prints one JSON line on stdout for each panel request the IBus daemon
relays: `ready` once it owns the name, `focus_in` with the input context path,
`cursor` with the caret rectangle the client application reported (screen
pixels, the rectangle a candidate window is placed against), `lookup` with the
candidate list an engine shows (its candidates, the highlighted index and
whether it is visible) and `hide_lookup`. It draws nothing and never answers
on the engine's or the application's behalf. Run it with a system Python that
provides PyGObject and the IBus typelib (gir1.2-ibus-1.0); it exits when the
IBus daemon goes away or on SIGTERM.
"""

import json
import signal
import sys

import gi

gi.require_version("IBus", "1.0")
from gi.repository import GLib, IBus


def emit(record: dict) -> None:
    sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Panel(IBus.PanelService):
    def do_focus_in(self, input_context_path: str) -> None:
        emit({"event": "focus_in", "context": input_context_path})

    def do_set_cursor_location(self, x: int, y: int, w: int, h: int) -> None:
        emit({"event": "cursor", "x": x, "y": y, "w": w, "h": h})

    def do_update_lookup_table(self, table: IBus.LookupTable, visible: bool) -> None:
        candidates = [
            table.get_candidate(index).get_text()
            for index in range(table.get_number_of_candidates())
        ]
        emit(
            {
                "event": "lookup",
                "visible": bool(visible),
                "candidates": candidates,
                "cursor": table.get_cursor_pos(),
                "page_size": table.get_page_size(),
            }
        )

    def do_hide_lookup_table(self) -> None:
        emit({"event": "hide_lookup"})


def main() -> int:
    IBus.init()
    bus = IBus.Bus()
    if not bus.is_connected():
        print("The IBus daemon is not running", file=sys.stderr)
        return 1
    loop = GLib.MainLoop()
    bus.connect("disconnected", lambda _bus: loop.quit())
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, loop.quit)
    panel = Panel(connection=bus.get_connection(), object_path=IBus.PATH_PANEL)
    reply = bus.request_name(IBus.SERVICE_PANEL, IBus.BusNameFlag.REPLACE_EXISTING)
    if reply not in (
        IBus.BusRequestNameReply.PRIMARY_OWNER,
        IBus.BusRequestNameReply.ALREADY_OWNER,
    ):
        print(f"Could not own {IBus.SERVICE_PANEL}: {reply}", file=sys.stderr)
        return 1
    emit({"event": "ready"})
    loop.run()
    del panel
    return 0


if __name__ == "__main__":
    sys.exit(main())
