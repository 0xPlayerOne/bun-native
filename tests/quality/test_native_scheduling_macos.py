"""Boundaries for the macOS scheduling evidence controller."""

import unittest

from scripts.quality.native_harness.native_scheduling_macos import (
    observed_paint_during,
    paint_progress,
)


class MacSchedulingEvidenceTests(unittest.TestCase):
    def test_only_newer_native_render_records_establish_progress(self):
        records = [
            {"type": "rendered", "tree_revision": 8},
            {"type": "layout", "tree_revision": 10},
            {"type": "rendered"},
        ]
        self.assertFalse(paint_progress(records, 8))
        records.append({"type": "rendered", "tree_revision": 9})
        self.assertTrue(paint_progress(records, 8))

    def test_paint_observation_requires_active_producer_before_and_after(self):
        active = [{"type": "stream-start"}]
        stopped = active + [{"type": "producer-stopped"}]
        paint = [{"type": "rendered", "tree_revision": 9}]
        self.assertTrue(observed_paint_during(active, paint, active, 8))
        self.assertFalse(observed_paint_during([], paint, active, 8))
        self.assertFalse(observed_paint_during(stopped, paint, stopped, 8))
        self.assertFalse(observed_paint_during(active, paint, stopped, 8))

    def test_empty_evidence_cannot_pass(self):
        self.assertFalse(paint_progress([], 1))


if __name__ == "__main__":
    unittest.main()
