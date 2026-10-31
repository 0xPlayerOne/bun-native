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


class PlatformRendererTelemetryTests(unittest.TestCase):
    def renderer(self):
        return {
            "type": "renderer",
            "window_id": 1,
            "gpu": {
                "is_software_emulated": True,
                "device_name": "test software adapter",
                "driver_name": "test driver",
                "driver_info": "",
            },
        }

    def test_pinned_macos_null_is_explicitly_unavailable_without_adapter_inference(
        self,
    ):
        renderer = {"type": "renderer", "window_id": 1, "gpu": None}
        result = SMOKE.renderer_telemetry(
            renderer, "Darwin", SMOKE.MACOS_GPU_TELEMETRY_UNAVAILABLE_REVISION
        )
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["window_id"], 1)
        self.assertIn("gpu_specs()", result["reason"])
        self.assertIn(SMOKE.MACOS_GPU_TELEMETRY_UNAVAILABLE_REVISION, result["source"])
        self.assertNotIn("is_software_emulated", result)
        self.assertNotIn("device_name", result)
        self.assertIsNone(renderer["gpu"])

    def test_null_does_not_qualify_another_platform_or_an_unreviewed_gpui_pin(self):
        renderer = {"type": "renderer", "window_id": 1, "gpu": None}
        for operating_system, revision in (
            ("Linux", SMOKE.MACOS_GPU_TELEMETRY_UNAVAILABLE_REVISION),
            ("Windows", SMOKE.MACOS_GPU_TELEMETRY_UNAVAILABLE_REVISION),
            ("Darwin", "unreviewed-revision"),
        ):
            with (
                self.subTest(operating_system=operating_system, revision=revision),
                self.assertRaisesRegex(RuntimeError, "did not report its adapter"),
            ):
                SMOKE.renderer_telemetry(renderer, operating_system, revision)

    def test_the_actual_renderer_record_cannot_be_missing_or_malformed(self):
        for renderer in (
            {},
            {"type": "renderer", "window_id": 1},
            {"type": "rendered", "window_id": 1, "gpu": None},
            {"type": "renderer", "window_id": True, "gpu": None},
            {"type": "renderer", "window_id": 0, "gpu": None},
        ):
            with (
                self.subTest(renderer=renderer),
                self.assertRaisesRegex(RuntimeError, "record is malformed"),
            ):
                SMOKE.renderer_telemetry(
                    renderer, "Darwin", SMOKE.MACOS_GPU_TELEMETRY_UNAVAILABLE_REVISION
                )

    def test_present_telemetry_is_required_to_be_valid_on_every_platform(self):
        valid = self.renderer()
        for operating_system in ("Darwin", "Linux", "Windows"):
            self.assertEqual(
                SMOKE.renderer_telemetry(
                    valid,
                    operating_system,
                    SMOKE.MACOS_GPU_TELEMETRY_UNAVAILABLE_REVISION,
                ),
                {"window_id": 1, "status": "reported"},
            )
            malformed = [[], {}, False]
            for field, value in (
                ("is_software_emulated", 1),
                ("is_software_emulated", "false"),
                ("device_name", ""),
                ("device_name", None),
                ("driver_name", None),
                ("driver_info", 1),
            ):
                malformed.append({**valid["gpu"], field: value})
            for gpu in malformed:
                with (
                    self.subTest(operating_system=operating_system, gpu=gpu),
                    self.assertRaisesRegex(RuntimeError, "metadata is malformed"),
                ):
                    SMOKE.renderer_telemetry(
                        {**valid, "gpu": gpu},
                        operating_system,
                        SMOKE.MACOS_GPU_TELEMETRY_UNAVAILABLE_REVISION,
                    )


if __name__ == "__main__":
    unittest.main()
