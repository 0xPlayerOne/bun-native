"""Portable paint expectation guards, separate from actual native execution."""

import copy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_platform_smoke", ROOT / "scripts/quality/native-platform-smoke.py"
)
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class PlatformPaintOwnershipTests(unittest.TestCase):
    def test_a_prior_window_paint_cannot_qualify_a_reopened_window(self):
        prior = SMOKE.expected_paint(1, False, "test-nonce")
        reopened = SMOKE.expected_paint(2, False, "test-nonce")
        self.assertFalse(SMOKE.EVIDENCE.matches_paint(prior, reopened))
        self.assertTrue(SMOKE.EVIDENCE.matches_paint(reopened, reopened))
        self.assertTrue(all(node["node_id"] > 6 for node in reopened["nodes"]))

    def test_update_requires_the_full_text_and_independent_input_revision(self):
        expected = SMOKE.expected_paint(3, True, "test-nonce")
        self.assertEqual(expected["nodes"][-1]["input_revision"], 1)
        for field, value in (("input_revision", 0), ("children", [1])):
            damaged = copy.deepcopy(expected)
            damaged["nodes"][-1][field] = value
            self.assertFalse(SMOKE.EVIDENCE.matches_paint(damaged, expected))
        damaged = copy.deepcopy(expected)
        damaged["nodes"][2]["element"]["text"] = "Native update 2"
        self.assertFalse(SMOKE.EVIDENCE.matches_paint(damaged, expected))
        self.assertFalse(
            SMOKE.EVIDENCE.matches_paint({**expected, "status": "omitted"}, expected)
        )


if __name__ == "__main__":
    unittest.main()
