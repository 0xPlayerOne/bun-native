"""Deterministic oracle controls; synthetic pixels are not native GUI evidence."""

import copy
import json
import unittest
from pathlib import Path

from scripts.quality.native_harness import native_input_viewport_paint as PAINT

ROOT = Path(__file__).resolve().parents[2]


def observation():
    return {
        "node_id": 7,
        "viewport": [10, 10, 60, 30],
        "clip": [10, 10, 60, 30],
        "offset": 42,
        "line_width": 100,
        "caret": [68, 10, 2, 30],
        "selection": None,
        "selected_bytes": [100, 100],
        "cursor_byte": 100,
    }


def records(framework="React"):
    state = {
        "input": {"value": PAINT.INITIAL_VALUE, "revision": 0},
        "edits": 0,
        "restyled": False,
    }
    nodes = []

    def flatten(tree):
        identity = len(nodes) + 1
        row = {"node_id": identity, "element": tree["element"], "children": []}
        nodes.append(row)
        if tree["element"]["kind"] == "input":
            row["input_revision"] = 0
        row["children"] = [flatten(child) for child in tree["children"]]
        return identity

    # A complete specimen isolates each negative below. Correspondence to the
    # real adapter source is established only by the separate actual-host run.
    flatten(PAINT.expected_tree(framework, state))
    paint = {
        "nonce": "owned",
        "type": "rendered",
        "stage": "native-paint",
        "window_id": 1,
        "tree_revision": 3,
        "nodes": nodes,
    }
    geometry = {
        "nonce": "owned",
        "type": "layout",
        "stage": "native-paint",
        "window_id": 1,
        "tree_revision": 3,
        "layout": {
            "status": "complete",
            "scale_factor": 1.0,
            "node_count": len(nodes),
            "viewport": [160.0, 60.0],
            "focused_node_id": 7,
            "nodes": [
                {
                    "node_id": row["node_id"],
                    "bounds": [0, 0, 160, 60],
                    "ancestor_clip": [0, 0, 160, 60],
                }
                for row in nodes
            ],
            "inputs": [observation()],
        },
    }
    return paint, geometry, state


def canvas():
    return bytearray([24, 36, 48] * (160 * 60))


def fill(pixels, bounds, color):
    x, y, width, height = bounds
    for py in range(y, y + height):
        for px in range(x, x + width):
            offset = (py * 160 + px) * 3
            pixels[offset : offset + 3] = bytes(color)


def pointer_records():
    position = [100.00152587890625, 130.00198364257812]
    application = [
        {
            "type": "viewport-event",
            "framework": "React",
            "nonce": "owned",
            "target": "input",
            "event": event,
            "sequence": sequence,
            "treeRevision": 3,
            "x": position[0],
            "y": position[1],
            "button": "left",
        }
        for event, sequence in (("pointer_down", 12), ("pointer_up", 13))
    ]
    native = [
        {
            "type": "pointer_trace",
            "nonce": "owned",
            "stage": "gpui-window-input",
            "window_id": 1,
            "event": event,
            "trace_index": index,
            "trace_limit": 64,
            "limit_reached": False,
            "window_active": True,
            "position": position.copy(),
            "button": "Left",
        }
        for event, index in (("down", 3), ("up", 4))
    ]
    return application, native


class InputViewportPaintControls(unittest.TestCase):
    def test_pointer_requires_fresh_native_and_public_down_up_pairs(self):
        application, native = pointer_records()

        def observed(app=application, host=native, app_offset=0, native_offset=0):
            return PAINT.pointer_delivery(
                app, host, app_offset, native_offset, "owned", [100, 130], 3, "React"
            )

        self.assertIsNotNone(observed())
        for app, host, app_offset, native_offset in (
            ([], native, 0, 0),
            (application, [], 0, 0),
            (application, native, 2, 0),
            (application, native, 0, 2),
            (application[:1], native, 0, 0),
            (application, native[:1], 0, 0),
            (list(reversed(application)), native, 0, 0),
            (application, list(reversed(native)), 0, 0),
        ):
            self.assertIsNone(observed(app, host, app_offset, native_offset))
        self.assertIsNone(observed(application + application, native + native, 2, 2))
        fresh_app, fresh_native = pointer_records()
        for row in fresh_app:
            row["sequence"] += 2
        for row in fresh_native:
            row["trace_index"] += 2
        self.assertIsNotNone(
            observed(application + fresh_app, native + fresh_native, 2, 2)
        )

    def test_pointer_rejects_foreign_targets_wrong_pixels_and_malformed_metadata(self):
        application, native = pointer_records()
        for field, value in (
            ("nonce", "foreign"),
            ("target", "button"),
            ("treeRevision", True),
            ("treeRevision", 4),
            ("sequence", 0),
            ("x", True),
            ("x", float("nan")),
            ("x", 99.5),
            ("x", 100.5),
            ("x", 101),
            ("button", "right"),
        ):
            changed = copy.deepcopy(application)
            changed[0][field] = value
            self.assertIsNone(
                PAINT.pointer_delivery(
                    changed, native, 0, 0, "owned", [100, 130], 3, "React"
                )
            )
        for field, value in (
            ("nonce", "foreign"),
            ("window_id", 2),
            ("window_id", True),
            ("stage", "application"),
            ("trace_index", True),
            ("trace_index", 4),
            ("trace_limit", 65),
            ("limit_reached", True),
            ("window_active", False),
            ("position", [float("inf"), 130]),
            ("position", [100, True]),
            ("position", [100, 129.5]),
            ("position", [100, 130.5]),
        ):
            changed = copy.deepcopy(native)
            changed[0][field] = value
            self.assertIsNone(
                PAINT.pointer_delivery(
                    application, changed, 0, 0, "owned", [100, 130], 3, "React"
                )
            )

    def test_complete_tree_revision_identity_and_current_input_are_required(self):
        for framework in ("Solid", "React"):
            paint, geometry, state = records(framework)
            self.assertIsNotNone(PAINT.frame(paint, geometry, state, framework))
            for damage in (
                lambda row: row["nodes"][6]["element"].update(value="stale"),
                lambda row: row["nodes"][6].update(input_revision=1),
                lambda row: row["nodes"][6]["element"]["style"].update(
                    overflow="hidden"
                ),
                lambda row: row["nodes"].pop(),
                lambda row: row["nodes"][0]["children"].append(1),
                lambda row: row.update(window_id=True),
                lambda row: row.update(stage="submitted"),
            ):
                changed = copy.deepcopy(paint)
                damage(changed)
                self.assertIsNone(PAINT.frame(changed, geometry, state, framework))

    def test_completed_layout_prefix_and_same_live_nodes_are_required(self):
        paint, geometry, state = records()
        older = copy.deepcopy(geometry)
        older["tree_revision"] = 2
        self.assertIsNotNone(PAINT.frame(paint, older, state, "React"))
        for damage in (
            lambda row: row.update(tree_revision=4),
            lambda row: row.update(window_id=2),
            lambda row: row.update(nonce="foreign"),
            lambda row: row["layout"]["nodes"].pop(),
            lambda row: row["layout"]["nodes"][0].update(node_id=777),
            lambda row: row["layout"]["inputs"][0].update(node_id=8),
            lambda row: row["layout"].update(inputs=[]),
        ):
            changed = copy.deepcopy(geometry)
            damage(changed)
            self.assertIsNone(PAINT.frame(paint, changed, state, "React"))

    def test_nonfinite_boolean_clipped_or_stale_geometry_is_rejected(self):
        paint, geometry, state = records()
        for field, value in (
            ("offset", float("nan")),
            ("offset", True),
            ("offset", -1),
            ("line_width", float("inf")),
            ("viewport", [10, 10, True, 30]),
            ("clip", [0, 0, 160, 60]),
            ("caret", [69, 10, 2, 30]),
            ("selected_bytes", [99, 101]),
            ("selected_bytes", [True, 100]),
            ("cursor_byte", 99),
        ):
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(geometry)
                changed["layout"]["inputs"][0][field] = value
                self.assertIsNone(PAINT.frame(paint, changed, state, "React"))

    def test_end_pixels_reject_deliberately_omitted_translation_and_wrong_caret(self):
        pixels = canvas()
        fill(pixels, [45, 20, 6, 8], [255, 255, 255])
        fill(pixels, [68, 10, 2, 30], [0, 0, 255])
        self.assertTrue(
            PAINT.pixel_counts(pixels, [160, 60], observation(), "end")["passed"]
        )
        untranslated = canvas()
        fill(untranslated, [100, 20, 6, 8], [255, 255, 255])
        fill(untranslated, [68, 10, 2, 30], [0, 0, 255])
        rejected = PAINT.pixel_counts(untranslated, [160, 60], observation(), "end")
        self.assertFalse(rejected["passed"])
        self.assertEqual(rejected["insideGlyph"], 0)
        self.assertGreater(rejected["outsideGlyph"], 0)
        for caret in (None, [10, 10, 2, 30], [80, 10, 2, 30]):
            wrong = canvas()
            fill(wrong, [45, 20, 6, 8], [255, 255, 255])
            if caret is not None:
                fill(wrong, caret, [0, 0, 255])
            self.assertFalse(
                PAINT.pixel_counts(wrong, [160, 60], observation(), "end")["passed"]
            )

    def test_focus_ring_is_host_chrome_but_padding_and_gutter_glyphs_still_fail(self):
        node = [6, 6, 68, 38]
        for column, passes in ((72, True), (70, False), (80, False)):
            with self.subTest(column=column):
                pixels = canvas()
                fill(pixels, [45, 20, 6, 8], [255, 255, 255])
                fill(pixels, [68, 10, 2, 30], [0, 0, 255])
                fill(pixels, [column, 10, 1, 30], [255, 255, 255])
                counts = PAINT.pixel_counts(
                    pixels, [160, 60], observation(), "end", node
                )
                self.assertEqual(counts["passed"], passes)
                # Without the node bounds nothing is exempt.
                self.assertFalse(
                    PAINT.pixel_counts(pixels, [160, 60], observation(), "end")[
                        "passed"
                    ]
                )

    def test_recorded_lcd_glyph_edge_is_not_an_opaque_caret(self):
        recorded = json.loads(
            (
                Path(__file__).parent / "fixtures/input-viewport-lcd-edge.json"
            ).read_text()
        )
        # The retained 5x5 neighborhood includes the original false positive at
        # (266,133), RGB (32,99,183). Only its placement and the remaining canvas
        # are synthetic; the recorded glyph fringe must not become a caret.
        pixels = canvas()
        fill(pixels, [45, 22, 6, 8], [255, 255, 255])
        fill(pixels, [68, 10, 2, 30], [0, 0, 255])
        for y, row in enumerate(recorded["rgb"]):
            for x, color in enumerate(row):
                fill(pixels, [43 + x, 15 + y, 1, 1], color)
        counts = PAINT.pixel_counts(pixels, [160, 60], observation(), "end")
        self.assertTrue(counts["passed"])
        self.assertEqual(counts["caret"], 60)
        self.assertEqual(counts["misplacedCaret"], 0)

        missing = pixels.copy()
        fill(missing, [68, 10, 2, 30], [24, 36, 48])
        counts = PAINT.pixel_counts(missing, [160, 60], observation(), "end")
        self.assertFalse(counts["passed"])
        self.assertEqual(counts["caret"], 0)

        # Even one genuine opaque caret pixel away from the expected edge must
        # fail, including when it replaces that exact antialiased fringe pixel.
        for position in ([45, 17, 1, 1], [80, 17, 1, 1]):
            misplaced = pixels.copy()
            fill(misplaced, position, [0, 0, 255])
            counts = PAINT.pixel_counts(misplaced, [160, 60], observation(), "end")
            self.assertFalse(counts["passed"])
            self.assertEqual(counts["misplacedCaret"], 1)

    def test_home_pixels_reject_deliberately_unclipped_tail(self):
        view = {
            **observation(),
            "offset": 0,
            "caret": [10, 10, 2, 30],
            "selected_bytes": [0, 0],
            "cursor_byte": 0,
        }
        pixels = canvas()
        fill(pixels, [10, 10, 2, 30], [0, 0, 255])
        self.assertTrue(PAINT.pixel_counts(pixels, [160, 60], view, "home")["passed"])
        fill(pixels, [100, 20, 6, 8], [255, 255, 255])
        counts = PAINT.pixel_counts(pixels, [160, 60], view, "home")
        self.assertFalse(counts["passed"])
        self.assertGreater(counts["outsideGlyph"], 0)

    def test_selected_pixels_require_visible_selection_with_no_caret_or_overflow(self):
        view = {
            **observation(),
            "caret": None,
            "selected_bytes": [0, 100],
            "selection": [10, 10, 58, 30],
        }
        pixels = canvas()
        fill(pixels, [10, 10, 58, 30], [36, 39, 93])
        fill(pixels, [50, 20, 6, 8], [255, 255, 255])
        self.assertTrue(
            PAINT.pixel_counts(pixels, [160, 60], view, "selection")["passed"]
        )
        overflow = pixels.copy()
        fill(overflow, [80, 10, 30, 30], [23, 23, 74])
        leaked = PAINT.pixel_counts(overflow, [160, 60], view, "selection")
        self.assertFalse(leaked["passed"])
        self.assertGreater(leaked["outsideSelection"], 0)
        missing = canvas()
        fill(missing, [50, 20, 6, 8], [255, 255, 255])
        self.assertFalse(
            PAINT.pixel_counts(missing, [160, 60], view, "selection")["passed"]
        )
        fill(pixels, [68, 10, 2, 30], [0, 0, 255])
        self.assertFalse(
            PAINT.pixel_counts(pixels, [160, 60], view, "selection")["passed"]
        )


if __name__ == "__main__":
    unittest.main()
