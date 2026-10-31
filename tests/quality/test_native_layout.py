"""Geometry guard negatives. These unit tests do not claim native rendering."""

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_layout", ROOT / "scripts/quality/native-layout-scenario.py"
)
LAYOUT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAYOUT)


class LayoutPointerBoundsTests(unittest.TestCase):
    def test_intermediate_wheel_paint_cannot_qualify_as_a_settled_offset(self):
        self.assertFalse(
            LAYOUT.at_scroll_end({"offset": [0, -87], "maximum": [0, 168]}, 1)
        )
        self.assertTrue(
            LAYOUT.at_scroll_end({"offset": [0, -168], "maximum": [0, 168]}, 1)
        )
        self.assertFalse(LAYOUT.at_scroll_end({"offset": [0, 0], "maximum": [0, 0]}, 1))

    def test_visible_point_uses_the_clipped_interior(self):
        self.assertEqual(
            LAYOUT.pointer_point([10, -50, 100, 100], [0, 20, 120, 100], [640, 480]),
            ("60", "35"),
        )

    def test_fully_clipped_or_foreign_viewport_points_are_rejected(self):
        for bounds, clip in (
            ([10, 200, 50, 20], [0, 0, 120, 100]),
            ([700, 100, 50, 20], [0, 0, 900, 900]),
        ):
            with self.assertRaises(RuntimeError):
                LAYOUT.pointer_point(bounds, clip, [640, 480])

    def test_negative_clipping_case_requires_an_in_window_invisible_point(self):
        self.assertEqual(
            LAYOUT.pointer_point(
                [10, 200, 50, 20], [0, 0, 120, 100], [640, 480], False
            ),
            ("35", "210"),
        )
        with self.assertRaisesRegex(RuntimeError, "actually visible"):
            LAYOUT.pointer_point([10, 20, 50, 20], [0, 0, 120, 100], [640, 480], False)
        with self.assertRaisesRegex(RuntimeError, "outside the owned viewport"):
            LAYOUT.pointer_point([10, 500, 50, 20], [0, 0, 120, 100], [640, 480], False)

    def test_malformed_native_geometry_never_becomes_a_pointer_command(self):
        for bounds in (
            [0, 0, -1, 20],
            [0, 0, 10, float("nan")],
            [0, False, 10, 20],
            [0, 0, 10],
            [float("inf"), 0, 10, 20],
        ):
            with self.assertRaisesRegex(
                RuntimeError, "Invalid native layout rectangle"
            ):
                LAYOUT.pointer_point(bounds, [0, 0, 100, 100], [640, 480])


if __name__ == "__main__":
    unittest.main()
