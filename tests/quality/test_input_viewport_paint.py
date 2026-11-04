"""Deterministic oracle controls; synthetic pixels are not native GUI evidence."""

import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "input_viewport_paint", ROOT / "scripts/quality/native-input-viewport-paint.py"
)
PAINT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAINT)


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


class InputViewportPaintControls(unittest.TestCase):
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
