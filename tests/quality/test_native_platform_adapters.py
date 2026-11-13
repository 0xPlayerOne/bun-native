"""Strict framework paint and owner guards; no native or OS input execution."""

import copy
import unittest
from pathlib import Path

from scripts.quality.native_harness import native_platform_smoke as SMOKE

ROOT = Path(__file__).resolve().parents[2]


class PlatformAdapterQualificationTests(unittest.TestCase):
    def test_framework_paints_require_both_owner_boxes_and_every_node(self):
        for framework in ("solid", "react"):
            expected = SMOKE.expected_paint(
                2, True, "nonce", os_input=True, framework=framework
            )
            self.assertEqual(
                [node["node_id"] for node in expected["nodes"]], list(range(9, 17))
            )
            self.assertEqual(expected["nodes"][0]["children"], [10])
            self.assertEqual(expected["nodes"][1]["children"], [11])
            self.assertEqual(expected["nodes"][2]["children"], [12, 13, 14, 15, 16])
            self.assertEqual(expected["nodes"][-1]["input_revision"], 6)
            self.assertTrue(SMOKE.EVIDENCE.matches_paint(expected, expected))
            for index in range(8):
                damaged = copy.deepcopy(expected)
                damaged["nodes"].pop(index)
                self.assertFalse(SMOKE.EVIDENCE.matches_paint(damaged, expected))
            prior = SMOKE.expected_paint(
                1, True, "nonce", os_input=True, framework=framework
            )
            self.assertFalse(SMOKE.EVIDENCE.matches_paint(prior, expected))
            core = SMOKE.expected_paint(2, True, "nonce", os_input=True)
            self.assertFalse(SMOKE.EVIDENCE.matches_paint(core, expected))

    def test_framework_cleanup_rejects_missing_wrong_or_retained_owners(self):
        record = {
            "framework": "solid",
            "ownerDisposals": 3,
            "revokedInputCallbacks": 99,
            "observedInputEvents": 99,
            "renderers": [
                {"nodes": 0, "listeners": 0, "pending": False} for _ in range(3)
            ],
        }
        self.assertTrue(SMOKE.adapter_cleanup_matches(record, "solid"))
        self.assertFalse(SMOKE.adapter_cleanup_matches(record, "react"))
        for key, value in (
            ("ownerDisposals", True),
            ("ownerDisposals", 2),
            ("observedInputEvents", True),
            ("observedInputEvents", -1),
            ("revokedInputCallbacks", 98),
            ("revokedInputCallbacks", True),
            ("renderers", []),
            ("renderers", None),
        ):
            self.assertFalse(
                SMOKE.adapter_cleanup_matches({**record, key: value}, "solid")
            )
        for key in record:
            damaged = copy.deepcopy(record)
            del damaged[key]
            self.assertFalse(SMOKE.adapter_cleanup_matches(damaged, "solid"))
        for key, value in (
            ("nodes", 1),
            ("nodes", False),
            ("listeners", 1),
            ("pending", True),
        ):
            damaged = copy.deepcopy(record)
            damaged["renderers"][1][key] = value
            self.assertFalse(SMOKE.adapter_cleanup_matches(damaged, "solid"))

    def test_adapter_inventory_binds_the_shared_fixture_and_selected_jsx(self):
        for framework in ("solid", "react"):
            snapshot = SMOKE.source_snapshot(framework)
            for path in (
                "tests/native/platform-adapter.ts",
                f"tests/native/{framework}-platform.tsx",
                f"packages/{framework}/package.json",
            ):
                self.assertEqual(
                    snapshot[path], SMOKE.DIAGNOSTICS.fingerprint(ROOT / path)
                )


if __name__ == "__main__":
    unittest.main()
