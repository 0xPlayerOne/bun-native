"""Layout assertions executed by the existing owned-window diagnostic driver."""

import math
import time


def rectangle(value):
    if (
        not isinstance(value, list)
        or len(value) != 4
        or any(
            type(item) not in (int, float) or not math.isfinite(item) for item in value
        )
        or any(abs(item) > 100_000_000 for item in value)
        or value[2] < 0
        or value[3] < 0
    ):
        raise RuntimeError("Invalid native layout rectangle")
    return value


def intersects(first, second):
    x, y, width, height = rectangle(first)
    other_x, other_y, other_width, other_height = rectangle(second)
    left, top = max(x, other_x), max(y, other_y)
    right, bottom = (
        min(x + width, other_x + other_width),
        min(y + height, other_y + other_height),
    )
    return [left, top, max(0, right - left), max(0, bottom - top)]


def pointer_point(bounds, clip, viewport, visible=True):
    """Never direct an injected pointer outside the owned client viewport."""
    bounds = rectangle(bounds)
    clip = rectangle(clip)
    if visible:
        bounds = intersects(bounds, clip)
    if bounds[2] < 2 or bounds[3] < 2:
        raise RuntimeError("Native target has no injectable interior")
    x, y = bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2
    if not (1 <= x < viewport[0] - 1 and 1 <= y < viewport[1] - 1):
        raise RuntimeError("Native target lies outside the owned viewport")
    if (
        not visible
        and clip[0] <= x < clip[0] + clip[2]
        and clip[1] <= y < clip[1] + clip[3]
    ):
        raise RuntimeError("Negative clipping target is actually visible")
    return str(round(x)), str(round(y))


def at_scroll_end(scroll, axis):
    """Wait for native clamping, not the first paint from a multi-event wheel burst."""
    maximum = scroll["maximum"][axis]
    return maximum > 0 and abs(scroll["offset"][axis] + maximum) <= 0.01


def run(
    driver,
    window,
    output,
    native_records,
    application_records,
    wait_for,
    require_owned,
    capture,
):
    """Return observed geometry; every OS action rechecks process/window ownership."""
    observations = {}

    def latest(kind):
        return next(
            (row for row in reversed(native_records()) if row.get("type") == kind), None
        )

    def layout():
        row = latest("layout")
        if not row or row.get("layout", {}).get("status") != "complete":
            return None
        result = row["layout"]
        if result.get("scale_factor") != 1:
            raise RuntimeError(
                "This bounded pointer fixture requires actual native scale 1"
            )
        if len(result.get("nodes", [])) != result.get("node_count"):
            raise RuntimeError("Native geometry omitted a model node")
        return result

    def geometry(node_id, state=None):
        state = layout() if state is None else state
        return next(node for node in state["nodes"] if node["node_id"] == node_id)

    def element(text):
        painted = latest("rendered")
        return next(
            node["node_id"]
            for node in painted["nodes"]
            if node["element"].get("text") == text
        )

    def application(kind):
        return next(
            (row for row in application_records() if row.get("type") == kind), None
        )

    def clicks(target):
        return sum(
            row.get("type") == "click" and row.get("target") == target
            for row in application_records()
        )

    def action(*arguments):
        require_owned()
        if driver.run(["xdotool", "getwindowfocus"]) != window:
            raise RuntimeError("Owned layout window lost focus before input")
        driver.run(["xdotool", *arguments])

    def click(node_id, visible=True):
        state = layout()
        node = geometry(node_id, state)
        verify_viewport(state)
        x, y = pointer_point(
            node["bounds"], node["ancestor_clip"], state["viewport"], visible
        )
        action("mousemove", "--window", window, x, y, "click", "1")

    def verify_viewport(state):
        require_owned()
        fields = dict(
            line.split("=", 1)
            for line in driver.run(
                ["xdotool", "getwindowgeometry", "--shell", window]
            ).splitlines()
            if "=" in line
        )
        if state["viewport"] != [int(fields["WIDTH"]), int(fields["HEIGHT"])]:
            raise RuntimeError(
                "Native viewport does not match the owned X11 client dimensions"
            )

    def stage(request, result):
        (output / request).touch()
        event = wait_for(lambda: application(result), result)
        wait_for(
            lambda: latest("rendered").get("tree_revision") == event["treeRevision"],
            result + " native paint",
        )
        return event

    initial = wait_for(
        lambda: (
            layout()
            if layout() and layout()["node_count"] == len(latest("rendered")["nodes"])
            else None
        ),
        "complete mounted native layout geometry",
    )
    minimum, bounded = element("Min 80"), element("Bounded")
    top, bottom, disabled = (
        element("Top action"),
        element("Bottom action"),
        element("Disabled"),
    )
    painted = latest("rendered")
    input_id = next(
        node["node_id"]
        for node in painted["nodes"]
        if node["element"]["kind"] == "input"
    )
    scroll = next(
        node["node_id"]
        for node in painted["nodes"]
        if node["element"].get("style", {}).get("overflow") == "scroll_y"
    )
    row_id = next(
        node["node_id"]
        for node in painted["nodes"]
        if node["children"] == [minimum, bounded, disabled]
    )

    def assert_row(state, expected_bounded):
        row = rectangle(geometry(row_id, state)["bounds"])
        first = rectangle(geometry(minimum, state)["bounds"])
        middle = rectangle(geometry(bounded, state)["bounds"])
        last = rectangle(geometry(disabled, state)["bounds"])
        assert abs(first[2] - 80) <= 0.5, first
        assert abs(middle[2] - expected_bounded) <= 0.5, middle
        for bounds in (first, middle, last):
            assert abs(bounds[1] + bounds[3] / 2 - row[1] - row[3] / 2) <= 0.5, bounds
        assert abs(first[0] - row[0]) <= 0.5
        assert abs(last[0] + last[2] - row[0] - row[2]) <= 0.5

    def scroll_state(state=None):
        state = layout() if state is None else state
        return next(item for item in state["scrolls"] if item["node_id"] == scroll)

    assert_row(initial, 200)
    assert scroll_state(initial)["offset"] == [0, 0]
    assert initial["focused_node_id"] == input_id
    observations["initial"] = initial
    click(top)
    wait_for(lambda: clicks("top") == 1, "visible pointer activation")
    click(bottom, visible=False)
    time.sleep(0.15)
    assert clicks("bottom") == 0, "Pointer activated a clipped descendant"

    state = layout()
    verify_viewport(state)
    viewport = scroll_state(state)["viewport"]
    x, y = pointer_point(viewport, viewport, state["viewport"])
    action(
        "mousemove",
        "--window",
        window,
        x,
        y,
        "click",
        "--repeat",
        "6",
        "--delay",
        "15",
        "5",
    )
    scrolled = wait_for(
        lambda: layout() if at_scroll_end(scroll_state(), 1) else None,
        "OS-wheel scroll endpoint",
    )
    offset = scroll_state(scrolled)["offset"]
    assert -scroll_state(scrolled)["maximum"][1] <= offset[1] < 0
    click(bottom)
    wait_for(lambda: clicks("bottom") == 1, "newly visible pointer activation")
    capture(window, "scrolled.png")
    observations["scrolled"] = scrolled

    click(input_id)
    action("key", "--clearmodifiers", "End", "Left")
    stage("restyle", "restyled")
    moved = wait_for(
        lambda: (
            layout()
            if geometry(scroll)["bounds"][1] > geometry(input_id)["bounds"][1]
            else None
        ),
        "keyed native scroll-container move",
    )
    assert scroll_state(moved)["offset"] == offset, (
        "Style/reorder reset retained scroll state"
    )
    assert moved["focused_node_id"] == input_id
    action("type", "--clearmodifiers", "--delay", "0", "x")
    wait_for(
        lambda: any(
            row.get("type") == "input"
            and row.get("value") == "ABxC"
            and row.get("revision") == 1
            for row in application_records()
        ),
        "caret-preserving edit after ancestor restyle",
    )
    stage("input-style", "input-styled")
    assert layout()["focused_node_id"] == input_id
    action("type", "--clearmodifiers", "--delay", "0", "Y")
    wait_for(
        lambda: any(
            row.get("type") == "input"
            and row.get("value") == "ABxYC"
            and row.get("revision") == 3
            for row in application_records()
        ),
        "caret-preserving edit after full input appearance Set",
    )
    observations["moved"] = moved

    for width, expected in ((420, 184), (800, 200)):
        action("windowsize", "--sync", window, str(width), "560")
        resized = wait_for(
            lambda: layout() if layout()["viewport"] == [width, 560] else None,
            "native OS resize",
        )
        assert_row(resized, expected)
        assert scroll_state(resized)["offset"] == offset
        assert scroll_state(resized)["viewport"][3] == 140
        observations["resized" + str(width)] = resized
    capture(window, "resized.png")

    stage("horizontal", "horizontal")
    horizontal = wait_for(
        lambda: (
            layout()
            if scroll_state()["offset"] == [0, 0] and scroll_state()["maximum"][0] > 0
            else None
        ),
        "horizontal mode clears the disabled vertical offset",
    )
    viewport = scroll_state(horizontal)["viewport"]
    verify_viewport(horizontal)
    x, y = pointer_point(viewport, viewport, horizontal["viewport"])
    action(
        "mousemove",
        "--window",
        window,
        x,
        y,
        "click",
        "--repeat",
        "4",
        "--delay",
        "15",
        "5",
    )
    horizontal = wait_for(
        lambda: layout() if scroll_state()["offset"][0] < 0 else None,
        "native horizontal viewport accepts wheel input",
    )
    assert scroll_state(horizontal)["offset"][1] == 0
    observations["horizontal"] = horizontal
    capture(window, "horizontal.png")
    stage("disable-scroll", "scroll-disabled")
    wait_for(
        lambda: layout()["scrolls"] == [], "turning scrolling off releases its handle"
    )
    stage("restore-scroll", "scroll-restored")
    restored = wait_for(
        lambda: (
            layout()
            if layout()["scrolls"] and scroll_state()["offset"] == [0, 0]
            else None
        ),
        "re-enabled scroll container starts at the origin",
    )
    viewport = scroll_state(restored)["viewport"]
    x, y = pointer_point(viewport, viewport, restored["viewport"])
    action(
        "mousemove",
        "--window",
        window,
        x,
        y,
        "click",
        "--repeat",
        "6",
        "--delay",
        "15",
        "5",
    )
    wait_for(
        lambda: at_scroll_end(scroll_state(), 1), "restored vertical scroll endpoint"
    )

    stage("shrink", "shrunk")
    shrunk = wait_for(
        lambda: (
            layout()
            if scroll_state()["offset"] == [0, 0] and scroll_state()["maximum"][1] == 0
            else None
        ),
        "scroll offset clamped after subtree deletion",
    )
    assert shrunk["focused_node_id"] == input_id
    for key, target, expected_count in (
        ("Tab", bottom, 2),
        ("Tab", top, 2),
        ("shift+Tab", bottom, 3),
    ):
        action("key", "--clearmodifiers", key)
        wait_for(
            lambda: layout()["focused_node_id"] == target, "rendered native focus order"
        )
        action("key", "--clearmodifiers", "Return")
        name = "bottom" if target == bottom else "top"
        wait_for(
            lambda: clicks(name) == expected_count,
            "keyboard activation in reordered tree",
        )
    observations["shrunk"] = shrunk
    stage("disable", "disabled")
    wait_for(
        lambda: layout()["focused_node_id"] is None, "focused disabled button revoked"
    )
    stage("dispose", "disposed")
    disposed = wait_for(
        lambda: layout() if layout()["scrolls"] == [] else None,
        "scroll handles released with removed subtree",
    )
    assert all(
        item["node_id"] not in (scroll, top, bottom) for item in disposed["nodes"]
    )
    observations["disposed"] = disposed
    capture(window, "after.png")
    action("key", "--clearmodifiers", "alt+F4")
    return observations
