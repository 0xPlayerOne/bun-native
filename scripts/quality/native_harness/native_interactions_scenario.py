"""Native event assertions within the existing owned-window diagnostic driver."""

import copy


def route(records, sequence, path, *, stop=None):
    """Validate complete listener order, including the target's two phases."""
    rows = [
        row
        for row in records
        if row.get("type") == "trace" and row.get("sequence") == sequence
    ]
    expected = [(name, "capture", True) for name in path[:-1]]
    expected.append((path[-1], "target", True))
    if stop != "immediate":
        expected.append((path[-1], "target", False))
    if stop is None:
        expected.extend((name, "bubble", False) for name in reversed(path[:-1]))
    actual = [(row["currentTarget"], row["phase"], row["capture"]) for row in rows]
    if actual != expected or any(
        row["path"] != path or row["target"] != path[-1] for row in rows
    ):
        raise RuntimeError(f"Incorrect native event route {sequence}: {actual}")
    if (
        len({row["event"] for row in rows}) != 1
        or len({row["treeRevision"] for row in rows}) != 1
    ):
        raise RuntimeError(
            "A native event changed its type or committed revision during dispatch"
        )
    return rows


def run(
    driver,
    geometry_tools,
    window,
    output,
    native_records,
    application_records,
    wait_for,
    require_owned,
    capture,
):
    """All input addresses the verified process's window and native geometry."""
    observations = {}

    def latest(kind):
        return next(
            (row for row in reversed(native_records()) if row.get("type") == kind), None
        )

    def application(kind):
        return next(
            (row for row in application_records() if row.get("type") == kind), None
        )

    def layout():
        row = latest("layout")
        if not row or row.get("layout", {}).get("status") != "complete":
            return None
        state = row["layout"]
        if state.get("scale_factor") != 1 or len(state.get("nodes", [])) != state.get(
            "node_count"
        ):
            raise RuntimeError("This fixture requires complete scale-1 native geometry")
        return state

    def action(*arguments):
        require_owned()
        if driver.run(["xdotool", "getwindowfocus"]) != window:
            raise RuntimeError("Owned interaction window lost focus before input")
        driver.run(["xdotool", *arguments])

    def element(text):
        return next(
            node["node_id"]
            for node in latest("rendered")["nodes"]
            if node["element"].get("text") == text
        )

    def click(node_id):
        state = layout()
        fields = dict(
            line.split("=", 1)
            for line in driver.run(
                ["xdotool", "getwindowgeometry", "--shell", window]
            ).splitlines()
            if "=" in line
        )
        if state["viewport"] != [int(fields["WIDTH"]), int(fields["HEIGHT"])]:
            raise RuntimeError(
                "Native geometry does not match the owned client viewport"
            )
        node = next(node for node in state["nodes"] if node["node_id"] == node_id)
        x, y = geometry_tools.pointer_point(
            node["bounds"], node["ancestor_clip"], state["viewport"]
        )
        action("mousemove", "--window", window, x, y, "click", "1")
        return [int(x), int(y)]

    def activation(count):
        return wait_for(
            lambda: next(
                (
                    row
                    for row in application_records()
                    if row.get("type") == "activation" and row.get("count") == count
                ),
                None,
            ),
            f"native activation {count}",
        )

    def event(kind, target, after=0):
        return next(
            (
                row
                for row in application_records()
                if row.get("type") == "trace"
                and row.get("event") == kind
                and row.get("target") == target
                and row.get("currentTarget") == "root"
                and row.get("capture") is True
                and row["sequence"] > after
            ),
            None,
        )

    def complete_route(sequence, path, stop=None):
        count = 2 * len(path) if stop is None else len(path) + (stop != "immediate")
        wait_for(
            lambda: (
                len(
                    [
                        row
                        for row in application_records()
                        if row.get("type") == "trace"
                        and row.get("sequence") == sequence
                    ]
                )
                >= count
            ),
            "complete event listener traversal",
        )
        return route(application_records(), sequence, path, stop=stop)

    def stage(request, result, paint=False):
        (output / request).touch()
        row = wait_for(lambda: application(result), result)
        if paint:
            wait_for(
                lambda: latest("rendered").get("tree_revision") == row["treeRevision"],
                result + " native paint",
            )
            wait_for(
                lambda: latest("layout").get("tree_revision") == row["treeRevision"],
                result + " native geometry",
            )
        return row

    initial = wait_for(
        lambda: layout() if layout() and layout()["node_count"] == 7 else None,
        "complete initial interaction geometry",
    )
    observations["initialGeometry"] = initial
    initial_paint = copy.deepcopy(latest("rendered"))
    button = element("Native action")
    input_id = next(
        node["node_id"]
        for node in initial_paint["nodes"]
        if node["element"]["kind"] == "input"
    )
    old_path = ["root", "panel", "action"]
    coordinates = click(button)
    first = activation(1)
    pointer_down = event("pointer_down", "action")
    pointer_up = event("pointer_up", "action")
    for value in (pointer_down, pointer_up):
        assert value["button"] == "left" and not any(value["modifiers"].values())
        assert (
            abs(value["x"] - coordinates[0]) < 0.1
            and abs(value["y"] - coordinates[1]) < 0.1
        )
        complete_route(value["sequence"], old_path)
    complete_route(first["sequence"], old_path)
    observations["pointer"] = {
        "injected": coordinates,
        "down": pointer_down,
        "up": pointer_up,
    }

    action("key", "--clearmodifiers", "Return")
    second = activation(2)
    key_down = wait_for(
        lambda: event("key_down", "action", first["sequence"]), "Enter key-down"
    )
    key_up = wait_for(
        lambda: event("key_up", "action", first["sequence"]), "Enter key-up"
    )
    assert key_down["key"] == key_up["key"] == "enter"
    assert key_down["sequence"] < second["sequence"] < key_up["sequence"]
    for row in (key_down, key_up, second):
        complete_route(row["sequence"], old_path)
    observations["keyboardActivation"] = {
        "down": key_down,
        "activation": second,
        "up": key_up,
    }

    action("key", "--clearmodifiers", "Tab")
    wait_for(lambda: layout()["focused_node_id"] == input_id, "native Tab focus")
    action("key", "--clearmodifiers", "Home", "Right")
    action("type", "--clearmodifiers", "--delay", "5", "x")
    wait_for(
        lambda: any(
            row.get("type") == "input"
            and row.get("value") == "AxBCD"
            and row.get("revision") == 1
            for row in application_records()
        ),
        "caret insertion",
    )
    action("key", "--clearmodifiers", "shift+Left")
    action("type", "--clearmodifiers", "--delay", "5", "Y")
    wait_for(
        lambda: any(
            row.get("type") == "input"
            and row.get("value") == "AYBCD"
            and row.get("revision") == 2
            for row in application_records()
        ),
        "selection replacement",
    )
    inputs = [row for row in application_records() if row.get("type") == "input"]
    for row in inputs:
        complete_route(row["sequence"], ["root", "panel", "input"])
    shift_left = next(
        row
        for row in application_records()
        if row.get("event") == "key_down"
        and row.get("key") == "left"
        and row.get("modifiers", {}).get("shift") is True
    )
    focus = [
        row
        for row in application_records()
        if row.get("event") in ("focus", "blur")
        and row.get("currentTarget") == "root"
        and row.get("capture")
    ]
    assert any(row["event"] == "focus" and row["target"] == "action" for row in focus)
    assert any(row["event"] == "blur" and row["target"] == "action" for row in focus)
    assert any(row["event"] == "focus" and row["target"] == "input" for row in focus)
    observations["editing"] = {
        "inputEvents": inputs,
        "shiftLeft": shift_left,
        "focus": focus,
    }

    for policy, count in (("stop", 3), ("immediate", 4)):
        stage("arm-" + policy, "armed-" + policy)
        before = activation(count - 1)["sequence"]
        click(button)
        activated = activation(count)
        down = event("pointer_down", "action", before)
        rows = complete_route(down["sequence"], old_path, policy)
        if policy == "stop":
            assert rows[-1]["propagationStopped"] is True
        complete_route(activated["sequence"], old_path)
        observations[policy] = {
            "pointerSequence": down["sequence"],
            "nativeActivationStillOccurred": activated,
        }

    stage("arm-hold-move", "armed-hold-move")
    click(button)
    held_move = wait_for(
        lambda: next(
            (
                row
                for row in application_records()
                if row.get("type") == "callback-held"
                and row.get("policy") == "hold-move"
            ),
            None,
        ),
        "pending old-path event",
    )
    moved = stage("commit-move", "moved", paint=True)
    (output / "release-move").touch()
    fifth = activation(5)
    assert (
        fifth["path"] == old_path and fifth["eventTreeRevision"] < moved["treeRevision"]
    )
    complete_route(held_move["sequence"], old_path)
    complete_route(fifth["sequence"], old_path)
    observations["queuedReparent"] = {
        "held": held_move,
        "moved": moved,
        "activation": fifth,
    }

    stage("arm-hold-delete", "armed-hold-delete")
    click(button)
    held_delete = wait_for(
        lambda: next(
            (
                row
                for row in application_records()
                if row.get("type") == "callback-held"
                and row.get("policy") == "hold-delete"
            ),
            None,
        ),
        "pending revoked-target event",
    )
    replaced = stage("commit-delete", "replaced", paint=True)
    assert replaced["activations"] == 5
    replacement = element("Replacement action")
    assert replacement > button, "Remount must not reuse a native node ID"
    click(replacement)
    sixth = activation(6)
    complete_route(sixth["sequence"], ["root", "alternate", "replacement"])
    removed_trace = [
        row
        for row in application_records()
        if row.get("type") == "trace" and row.get("sequence") == held_delete["sequence"]
    ]
    assert len(removed_trace) == 1 and removed_trace[0]["currentTarget"] == "root"
    observations["queuedDelete"] = {
        "held": held_delete,
        "replaced": replaced,
        "remountActivation": sixth,
    }
    completed = stage("complete", "complete")

    expected = {
        "tree_revision": completed["treeRevision"],
        "nodes": initial_paint["nodes"],
    }
    panel_id = next(
        node["node_id"]
        for node in expected["nodes"]
        if node["children"] == [button, input_id]
    )
    alternate_id = next(
        node["node_id"]
        for node in expected["nodes"]
        if node["element"]["kind"] == "box" and node["children"] == []
    )
    expected["nodes"] = [
        node for node in expected["nodes"] if node["node_id"] != button
    ]
    for node in expected["nodes"]:
        if node["element"].get("text") == "Activations: 0":
            node["element"]["text"] = "Activations: 6"
        if node["node_id"] == input_id:
            node["element"]["value"], node["input_revision"] = "AYBCD", 2
        if node["node_id"] == panel_id:
            node["children"] = [input_id]
        if node["node_id"] == alternate_id:
            node["children"] = [replacement]
    expected["nodes"].append(
        {
            "node_id": replacement,
            "children": [],
            "element": {
                "kind": "button",
                "text": "Replacement action",
                "disabled": False,
                "style": {"width": 200, "height": 44},
            },
        }
    )
    wait_for(
        lambda: any(driver.matches_paint(row, expected) for row in native_records()),
        "complete final native interaction tree and editor paint",
    )
    observations["finalNativePaint"] = expected
    capture(window, "after.png")
    require_owned()
    driver.run(["xdotool", "key", "--clearmodifiers", "alt+F4"])
    return observations
