"""One bounded actual-OS viewport flow through either public framework adapter."""

import importlib.util
import json
import math
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "input_viewport_paint", Path(__file__).with_name("native-input-viewport-paint.py")
)
PAINT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAINT)


def run(
    driver,
    _geometry_tools,
    window,
    output,
    native_records,
    application_records,
    wait_for,
    require_owned,
    capture,
):
    observations = {}
    states = application_records()
    mounted = next((row for row in states if row.get("type") == "mounted"), None)
    if mounted is None or "framework" not in mounted:
        raise RuntimeError("Input viewport application never recorded its mount")
    framework = mounted["framework"]
    identity = None

    def retain():
        (output / "input-viewport-observations.json").write_text(
            json.dumps(observations, indent=2) + "\n"
        )

    def latest(rows, kind):
        return next((row for row in reversed(rows) if row.get("type") == kind), None)

    def current_frame():
        records = native_records()
        state = latest(application_records(), "viewport-state")
        return PAINT.frame(
            latest(records, "rendered"),
            latest(records, "layout"),
            state["state"] if state else None,
            framework,
        )

    def wait_frame(description, predicate=lambda _: True):
        def matches():
            current = current_frame()
            return current if current and predicate(current) else None

        return wait_for(matches, description)

    def action(*arguments):
        require_owned()
        if driver.run(["xdotool", "getwindowfocus"]) != window:
            raise RuntimeError("Owned viewport window lost focus before input")
        driver.run(["xdotool", *arguments])

    def state_is(current, value, revision, edits, restyled=False):
        return current["state"] == {
            "input": {"value": value, "revision": revision},
            "edits": edits,
            "restyled": restyled,
        }

    def edge(current, name):
        view = current["input"]
        x, y, width, height = view["viewport"]
        length = len(current["state"]["input"]["value"].encode("utf-8"))
        target = 0 if name == "home" else length
        expected_x = x if name == "home" else x + width - 2
        return (
            current["layout"]["focused_node_id"] == identity
            and view["node_id"] == identity
            and view["selected_bytes"] == [target, target]
            and view["cursor_byte"] == target
            and view["caret"] is not None
            and all(
                abs(a - b) < 0.001
                for a, b in zip(view["caret"], [expected_x, y, 2, height], strict=True)
            )
            and (view["offset"] == 0 if name == "home" else view["offset"] > 0)
        )

    def key(name, key_name, predicate):
        previous = len(application_records())
        action("key", "--clearmodifiers", key_name)

        def delivered():
            return any(
                row.get("type") == "viewport-event"
                and row.get("event") == "key_up"
                and row.get("key") == name
                for row in application_records()[previous:]
            )

        wait_for(delivered, f"fresh actual {key_name} key release")
        return wait_frame(f"completed native {key_name} geometry", predicate)

    def pixels(name, mode, predicate):
        def displayed():
            current = current_frame()
            if not current or not predicate(current):
                return False
            require_owned()
            size = [int(value) for value in current["layout"]["viewport"]]
            fields = dict(
                line.split("=", 1)
                for line in driver.run(
                    ["xdotool", "getwindowgeometry", "--shell", window]
                ).splitlines()
            )
            if size != [int(fields["WIDTH"]), int(fields["HEIGHT"])]:
                raise RuntimeError(
                    "Native viewport differs from owned X11 client geometry"
                )
            capture(window, f"{name}.png")
            counts = PAINT.pixel_counts(
                PAINT.screenshot(output / f"{name}.png", size),
                size,
                current["input"],
                mode,
            )
            observations[name] = {
                "frame": current,
                "pixels": counts,
                "screenshot": f"{name}.png",
            }
            retain()
            return current if counts["passed"] else False

        # The existing bounded wait observes presentation after paint; it never
        # relaunches the host or repeats the source/OS action that is under test.
        return wait_for(displayed, f"actual {name} pixels")

    initial = wait_frame(
        "complete initial input viewport tree",
        lambda row: state_is(row, PAINT.INITIAL_VALUE, 0, 0),
    )
    identity = initial["input"]["node_id"]
    view = initial["input"]
    if not view["line_width"] > view["viewport"][2] + 100:
        raise RuntimeError("Actual shaped text does not overflow the input")
    if (
        view["viewport"][0] + view["line_width"]
        >= initial["layout"]["viewport"][0] - 24
    ):
        raise RuntimeError("The visible gutter cannot expose an omitted text clip")
    observations["initial"] = initial
    retain()
    # There is exactly one native tab stop. Focus uses an OS key, not a command.
    action("key", "--clearmodifiers", "Tab")
    key("end", "End", lambda row: edge(row, "end"))
    pixels(
        "initial-end",
        "end",
        lambda row: edge(row, "end") and state_is(row, PAINT.INITIAL_VALUE, 0, 0),
    )
    key("home", "Home", lambda row: edge(row, "home"))
    pixels(
        "home",
        "home",
        lambda row: edge(row, "home") and state_is(row, PAINT.INITIAL_VALUE, 0, 0),
    )
    end = key("end", "End", lambda row: edge(row, "end"))
    before_pointer = key(
        "left",
        "Left",
        lambda row: (
            row["input"]["cursor_byte"] == 99
            and row["input"]["selected_bytes"] == [99, 99]
            and row["input"]["offset"] == end["input"]["offset"]
        ),
    )
    observations["before-pointer"] = before_pointer
    app_offset = len(application_records())
    native_offset = len(native_records())
    # Click the visible caret's last pixel. Without inverse viewport translation
    # the native edit lands in the blank prefix and fails the exact value oracle.
    x, y, width, height = end["input"]["viewport"]
    point = [math.floor(x + width - 1), math.floor(y + height / 2)]
    action(
        "mousemove",
        "--window",
        window,
        str(point[0]),
        str(point[1]),
        "click",
        "1",
    )
    observations["pointerDelivery"] = wait_for(
        lambda: PAINT.pointer_delivery(
            application_records(),
            native_records(),
            app_offset,
            native_offset,
            end["paint"]["nonce"],
            point,
            end["paint"]["tree_revision"],
            framework,
        ),
        "fresh native and public-listener pointer down/up at the injected pixel",
    )
    retain()
    wait_frame(
        "actual pointer mapped to the final text byte", lambda row: edge(row, "end")
    )
    action("type", "--clearmodifiers", "--delay", "10", "x")
    wait_frame(
        "pointer insertion at scrolled text end",
        lambda row: state_is(row, PAINT.INITIAL_VALUE + "x", 1, 1),
    )
    selected = key(
        "left",
        "shift+Left",
        lambda row: (
            row["input"]["selected_bytes"] == [100, 101]
            and row["input"]["cursor_byte"] == 100
            and row["input"]["selection"] is not None
            and row["input"]["caret"] is None
        ),
    )
    observations["one-character-selection"] = selected
    capture(window, "one-character-selection.png")
    action("type", "--clearmodifiers", "--delay", "10", "Y")
    changed = wait_frame(
        "native selected-character replacement",
        lambda row: state_is(row, PAINT.INITIAL_VALUE + "Y", 2, 2) and edge(row, "end"),
    )
    width_before = changed["input"]["viewport"][2]
    action("windowsize", window, "680", "400")
    resized = pixels(
        "resized-end",
        "end",
        lambda row: (
            row["layout"]["viewport"] == [680, 400]
            and row["input"]["viewport"][2] == width_before - 80
            and edge(row, "end")
            and state_is(row, PAINT.INITIAL_VALUE + "Y", 2, 2)
        ),
    )
    key(
        "f6",
        "F6",
        lambda row: (
            state_is(row, PAINT.INITIAL_VALUE + "Y", 3, 2, True) and edge(row, "end")
        ),
    )
    restyled = pixels(
        "restyled-end",
        "end",
        lambda row: (
            state_is(row, PAINT.INITIAL_VALUE + "Y", 3, 2, True)
            and edge(row, "end")
            and row["input"]["line_width"] > resized["input"]["line_width"]
        ),
    )
    assert restyled["input"]["node_id"] == identity
    key(
        "a",
        "ctrl+a",
        lambda row: (
            row["input"]["selected_bytes"] == [0, 101]
            and row["input"]["selection"] is not None
            and row["input"]["caret"] is None
        ),
    )
    pixels(
        "clipped-selection",
        "selection",
        lambda row: (
            row["input"]["selected_bytes"] == [0, 101]
            and row["input"]["selection"] is not None
            and state_is(row, PAINT.INITIAL_VALUE + "Y", 3, 2, True)
        ),
    )
    key(
        "backspace",
        "BackSpace",
        lambda row: state_is(row, "", 4, 3, True) and edge(row, "home"),
    )
    pixels(
        "empty", "home", lambda row: state_is(row, "", 4, 3, True) and edge(row, "home")
    )
    action("type", "--clearmodifiers", "--delay", "10", "short")
    final = pixels(
        "short",
        "short",
        lambda row: (
            state_is(row, "short", 9, 8, True)
            and row["input"]["offset"] == 0
            and row["input"]["node_id"] == identity
            and row["input"]["cursor_byte"] == 5
            and row["input"]["selected_bytes"] == [5, 5]
            and row["layout"]["focused_node_id"] == identity
            and row["input"]["caret"] is not None
        ),
    )
    observations["final"] = final
    retain()
    action("key", "--clearmodifiers", "alt+F4")
    return observations
