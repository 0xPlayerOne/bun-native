"""Complete native tree/paint geometry and independent screenshot predicates."""

import math
import subprocess

from . import native_solid_workspace_paint as TREE

INITIAL_VALUE = " " * 96 + "TAIL"


def expected_tree(framework, state):
    """Every element/property/child is checked independently of the adapter."""
    box, text, node = TREE.box, TREE.text, TREE.node
    app = box(
        [
            text(
                f"{framework} native input viewport",
                height=32,
                font_size=24,
                color=0xFFFFFF,
            ),
            text(
                f"Mode: {'restyled' if state['restyled'] else 'original'}; edits: {state['edits']}",
                height=24,
                color=0xFFFFFF,
            ),
            box(
                [
                    node(
                        "input",
                        value=state["input"]["value"],
                        placeholder="",
                        style={
                            "width": 0,
                            "min_width": 80,
                            "flex_grow": 1,
                            "height": 56,
                            "font_size": 24 if state["restyled"] else 20,
                            "background": 0x202C38 if state["restyled"] else 0x182430,
                            "color": 0xFFFFFF,
                            "overflow": "visible",
                        },
                    ),
                    box([], width=320, height=56, flex_shrink=0),
                ],
                direction="row",
                width="fill",
                height=56,
                gap=16,
            ),
            text(
                "Owned native input geometry and pixel control",
                height=24,
                color=0xFFFFFF,
            ),
        ],
        direction="column",
        width="fill",
        height="fill",
        padding=24,
        gap=12,
        background=0x101820,
    )
    return box([box([app], width="fill", height="fill")])


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def rectangle(value):
    return (
        isinstance(value, list)
        and len(value) == 4
        and all(number(item) for item in value)
        and value[2] >= 0
        and value[3] >= 0
    )


def contains(outer, inner):
    # GPUI serializes f32 positions and extents separately; only their addition
    # can differ at the final decimal. This is not a pixel-matching tolerance.
    return all(
        (
            inner[0] >= outer[0] - 0.001,
            inner[1] >= outer[1] - 0.001,
            inner[0] + inner[2] <= outer[0] + outer[2] + 0.001,
            inner[1] + inner[3] <= outer[1] + outer[3] + 0.001,
        )
    )


def frame(paint, geometry, state, framework):
    """Changed geometry precedes its paint; unchanged geometry may be reused."""
    try:
        if (
            framework not in ("Solid", "React")
            or type(state["restyled"]) is not bool
            or type(state["edits"]) is not int
            or not 0 <= state["edits"] <= 8
            or type(state["input"]["revision"]) is not int
            or not 0 <= state["input"]["revision"] <= 9
            or not isinstance(state["input"]["value"], str)
            or TREE.painted_tree(paint) != expected_tree(framework, state)
        ):
            return None
        if (
            not isinstance(geometry, dict)
            or geometry.get("type") != "layout"
            or geometry.get("stage") != "native-paint"
            or type(geometry.get("window_id")) is not int
            or geometry["window_id"] != 1
            or type(geometry.get("tree_revision")) is not int
            or not 1 <= geometry["tree_revision"] <= paint["tree_revision"]
            or not isinstance(paint.get("nonce"), str)
            or not paint["nonce"]
            or geometry.get("nonce") != paint["nonce"]
        ):
            return None
        layout = geometry["layout"]
        rows = layout["nodes"]
        if (
            layout["status"] != "complete"
            or type(layout["scale_factor"]) not in (int, float)
            or layout["scale_factor"] != 1
            or type(layout["node_count"]) is not int
            or layout["node_count"] != len(rows)
            or any(type(row["node_id"]) is not int for row in rows)
            or len({row["node_id"] for row in rows}) != len(rows)
            or {row["node_id"] for row in rows}
            != {row["node_id"] for row in paint["nodes"]}
            or any(
                not rectangle(row["bounds"]) or not rectangle(row["ancestor_clip"])
                for row in rows
            )
        ):
            return None
        size = layout["viewport"]
        if (
            not isinstance(size, list)
            or len(size) != 2
            or any(
                not number(v) or int(v) != v or not 0 < v <= maximum
                for v, maximum in zip(size, (1280, 800), strict=True)
            )
        ):
            return None
        inputs = [row for row in paint["nodes"] if row["element"]["kind"] == "input"]
        if (
            len(inputs) != 1
            or inputs[0]["input_revision"] != state["input"]["revision"]
        ):
            return None
        identity = inputs[0]["node_id"]
        observations = layout["inputs"]
        if (
            len(observations) != 1
            or type(observations[0]["node_id"]) is not int
            or observations[0]["node_id"] != identity
        ):
            return None
        observation = observations[0]
        viewport = observation["viewport"]
        if (
            not rectangle(viewport)
            or min(viewport[2:]) <= 2
            or observation["clip"] != viewport
            or not contains([0, 0, *size], viewport)
            or not contains(
                next(row["bounds"] for row in rows if row["node_id"] == identity),
                viewport,
            )
            or not number(observation["offset"])
            or not number(observation["line_width"])
            or not 0 <= observation["offset"] <= observation["line_width"]
        ):
            return None
        selected = observation["selected_bytes"]
        length = len(state["input"]["value"].encode("utf-8"))
        cursor = observation["cursor_byte"]
        if (
            not isinstance(selected, list)
            or len(selected) != 2
            or any(type(index) is not int for index in selected)
            or not 0 <= selected[0] <= selected[1] <= length
            or type(cursor) is not int
            or cursor not in selected
        ):
            return None
        for decoration in ("caret", "selection"):
            value = observation[decoration]
            if value is not None and (
                not rectangle(value) or not contains(viewport, value)
            ):
                return None
        if observation["caret"] is not None and selected[0] != selected[1]:
            return None
        return {
            "paint": paint,
            "layoutRecord": geometry,
            "layout": layout,
            "input": observation,
            "state": state,
        }
    except (KeyError, TypeError, ValueError, StopIteration):
        return None


def screenshot(path, size):
    width, height = size
    dimensions = subprocess.run(
        ["convert", str(path), "-format", "%w %h", "info:"],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout
    if dimensions != f"{width} {height}":
        raise RuntimeError(
            "Screenshot dimensions differ from the native scale-1 viewport"
        )
    pixels = subprocess.run(
        ["convert", str(path), "-depth", "8", "rgb:-"],
        check=True,
        capture_output=True,
        timeout=5,
    ).stdout
    if len(pixels) != width * height * 3:
        raise RuntimeError("Screenshot RGB payload has unexpected dimensions")
    return pixels


def pointer_delivery(
    application, native, app_offset, native_offset, nonce, point, revision, framework
):
    """One fresh native capture and public input-listener down/up pair.

    X11's pinned 16.16 conversion can produce a small f32 fraction at integer
    coordinates. Require the same logical pixel with strict half-pixel bounds;
    non-numbers, non-finite values and half-pixel ties cannot qualify.
    """
    if (
        type(app_offset) is not int
        or not 0 <= app_offset <= len(application)
        or type(native_offset) is not int
        or not 0 <= native_offset <= len(native)
    ):
        return None

    def same_point(position):
        return (
            isinstance(position, list)
            and len(position) == 2
            and all(
                number(value) and type(target) is int and abs(value - target) < 0.5
                for value, target in zip(position, point, strict=True)
            )
        )

    app_rows = [
        row
        for row in application[app_offset:]
        if row.get("type") == "viewport-event"
        and row.get("event") in ("pointer_down", "pointer_up")
    ]
    native_rows = [
        row
        for row in native[native_offset:]
        if row.get("type") == "pointer_trace" and row.get("event") in ("down", "up")
    ]
    if len(app_rows) != 2 or len(native_rows) != 2:
        return None
    for row, event in zip(app_rows, ("pointer_down", "pointer_up"), strict=True):
        if (
            row.get("event") != event
            or row.get("nonce") != nonce
            or row.get("framework") != framework
            or row.get("target") != "input"
            or row.get("button") != "left"
            or type(row.get("sequence")) is not int
            or row["sequence"] <= 0
            or type(row.get("treeRevision")) is not int
            or row["treeRevision"] != revision
            or not same_point([row.get("x"), row.get("y")])
        ):
            return None
    for row, event in zip(native_rows, ("down", "up"), strict=True):
        if (
            row.get("event") != event
            or row.get("nonce") != nonce
            or row.get("stage") != "gpui-window-input"
            or type(row.get("window_id")) is not int
            or row["window_id"] != 1
            or row.get("button") != "Left"
            or row.get("window_active") is not True
            or type(row.get("trace_index")) is not int
            or not 1 <= row["trace_index"] < 64
            or type(row.get("trace_limit")) is not int
            or row["trace_limit"] != 64
            or row.get("limit_reached") is not False
            or not same_point(row.get("position"))
        ):
            return None
    if (
        app_rows[0]["sequence"] >= app_rows[1]["sequence"]
        or native_rows[0]["trace_index"] >= native_rows[1]["trace_index"]
    ):
        return None
    prior_sequences = [
        row.get("sequence")
        for row in application[:app_offset]
        if row.get("type") == "viewport-event"
    ]
    prior_indices = [
        row.get("trace_index")
        for row in native[:native_offset]
        if row.get("type") == "pointer_trace"
    ]
    if (
        any(type(value) is not int for value in prior_sequences + prior_indices)
        or app_rows[0]["sequence"] <= max(prior_sequences, default=0)
        or native_rows[0]["trace_index"] <= max(prior_indices, default=0)
    ):
        return None
    return {
        "application": app_rows,
        "native": native_rows,
        "applicationOffset": app_offset,
        "nativeOffset": native_offset,
        "position": point,
    }


FOCUS_RING_WIDTH = 3


def in_ring(node, x, y):
    """Whether a pixel centre lies in the focus-ring band along a node's edge."""
    left, top, width, height = node
    inside = left <= x < left + width and top <= y < top + height
    deeper = (
        left + FOCUS_RING_WIDTH <= x < left + width - FOCUS_RING_WIDTH
        and top + FOCUS_RING_WIDTH <= y < top + height - FOCUS_RING_WIDTH
    )
    return inside and not deeper


def pixel_counts(pixels, size, observation, mode, node=None):
    """Detect actual white glyphs/blue caret, including the unclipped tail gutter.

    The whitespace prefix contains no glyph pixels. End must show TAIL; Home
    must show none, even in the visible gutter where an unclipped TAIL would lie.
    These predicates also reject deliberately untranslated/unclipped RGB controls.

    `node` is the focused input's layout bounds [x, y, w, h]. Its keyboard focus
    ring (an inset white edge over a dark band, FOCUS_RING_WIDTH pixels deep) is
    host chrome, not text, so those edge pixels are skipped; the padding between
    the ring and the text viewport and everything beyond the node still count.
    """
    width, height = size
    if len(pixels) != width * height * 3 or mode not in (
        "home",
        "end",
        "selection",
        "short",
    ):
        raise ValueError("Invalid input viewport pixel control")
    x, y, w, h = observation["viewport"]
    counts = {
        "insideGlyph": 0,
        "outsideGlyph": 0,
        "caret": 0,
        "misplacedCaret": 0,
        "selection": 0,
        "selectionArea": 0,
        "outsideSelection": 0,
    }
    if mode == "home":
        expected_caret = [x, y, 2, h]
    elif mode == "end":
        expected_caret = [x + w - 2, y, 2, h]
    else:
        expected_caret = observation["caret"]
    for py in range(max(0, math.ceil(y)), min(height, math.floor(y + h))):
        for px in range(max(0, math.ceil(x)), width - 24):
            if node is not None and in_ring(node, px + 0.5, py + 0.5):
                continue
            offset = (py * width + px) * 3
            red, green, blue = pixels[offset : offset + 3]
            inside = x <= px + 0.5 < x + w
            glyph = min(red, green, blue) >= 170
            counts["insideGlyph" if inside else "outsideGlyph"] += int(glyph)
            # The same translucent selection over the dark exterior gutter is
            # approximately (23,23,74), darker than its input-background color.
            selection_tint = (
                blue >= 60
                and blue > red + 25
                and blue > green + 25
                and max(red, green) < 100
            )
            counts["outsideSelection"] += int(not inside and selection_tint)
            # input/paint.rs fills the scale-1, opaque caret with gpui::blue().
            # White glyphs have colored LCD fringes (the retained native case
            # includes RGB 32,99,183), so blue dominance cannot identify it.
            if (red, green, blue) == (0, 0, 255):
                caret = expected_caret
                at_caret = (
                    caret is not None
                    and caret[0] - 1 <= px + 0.5 <= caret[0] + caret[2] + 1
                )
                counts["caret" if inside and at_caret else "misplacedCaret"] += 1
            if x + 4 <= px + 0.5 < x + w - 6 and y + 4 <= py + 0.5 < y + h - 4:
                counts["selectionArea"] += 1
                counts["selection"] += int(
                    blue >= 80
                    and blue > red + 30
                    and blue > green + 30
                    and max(red, green) < 100
                )
    counts["passed"] = (
        counts["outsideGlyph"] == 0
        and counts["outsideSelection"] == 0
        and counts["misplacedCaret"] == 0
        and (
            counts["insideGlyph"] == 0
            if mode == "home"
            else counts["insideGlyph"] >= 12
        )
        and (
            counts["selection"] > counts["selectionArea"] / 2
            if mode == "selection"
            else counts["caret"] >= max(4, math.floor(h))
        )
    )
    return counts
