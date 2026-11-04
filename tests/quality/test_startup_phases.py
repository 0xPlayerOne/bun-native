"""Headless controls for first-open phase attribution; no native acceptance claim."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "startup_run", ROOT / "experiments/startup-phases/run.py"
)
RUN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUN)


class StartupPhaseTests(unittest.TestCase):
    correlation = "synthetic-phase-observation"

    def request(self):
        return {
            "nonce": self.correlation,
            "source": "transport",
            "pid": 10,
            "host_pid": 20,
            "phase": "request_queued",
            "request_id": 3,
            "command": "open",
            "elapsed_ns": "999999999",
        }

    def marker(self, label, elapsed, **extra):
        return {
            "nonce": self.correlation,
            "source": "native-log",
            "pid": 20,
            "phase": "log",
            "message": f"BN_PHASE {label}",
            "elapsed_ns": str(elapsed),
            **extra,
        }

    def summarize(self, records):
        return RUN.first_open_phases([self.request(), *records], self.correlation)

    def test_timeout_retains_nested_unfinished_phase_without_cross_clock_duration(self):
        result = self.summarize(
            [
                self.marker("renderer_enter", 100),
                self.marker("instance_enter", 110),
                {
                    "nonce": self.correlation,
                    "source": "transport",
                    "pid": 10,
                    "phase": "transport_failed",
                    "error": "Native open request 3 timed out",
                    "elapsed_ns": "1",
                },
            ]
        )
        self.assertTrue(result["firstOpenTimedOut"])
        self.assertEqual(result["innermostUnfinishedPhase"], "instance")
        self.assertEqual(
            [row["phase"] for row in result["unfinishedPhases"]],
            ["renderer", "instance"],
        )
        self.assertEqual(result["completedPhaseDurations"], [])

    def test_completed_phase_duration_uses_only_the_native_logger_clock(self):
        result = self.summarize(
            [
                self.marker("renderer_enter", 100),
                self.marker("instance_enter", 150),
                self.marker("instance_return", 250),
                self.marker("renderer_return", 400),
            ]
        )
        self.assertEqual(result["unfinishedPhases"], [])
        self.assertEqual(
            result["completedPhaseDurations"],
            [
                {"phase": "instance", "outcome": "ok", "durationNs": "100"},
                {"phase": "renderer", "outcome": "ok", "durationNs": "300"},
            ],
        )

    def test_x11_phase_names_with_digits_are_validated_and_paired(self):
        result = self.summarize(
            [
                self.marker("x11_colormap_enter", 10),
                self.marker("x11_colormap_return", 20),
                self.marker("x11_setup_enter", 30),
                self.marker("x11_setup_return", 50),
            ]
        )
        self.assertEqual(result["unfinishedPhases"], [])
        self.assertEqual(
            result["completedPhaseDurations"],
            [
                {"phase": "x11_colormap", "outcome": "ok", "durationNs": "10"},
                {"phase": "x11_setup", "outcome": "ok", "durationNs": "20"},
            ],
        )

    def test_later_window_markers_cannot_change_first_open_attribution(self):
        result = self.summarize(
            [
                self.marker("renderer_enter", 100),
                self.marker("renderer_return", 200),
                {
                    "nonce": self.correlation,
                    "source": "native",
                    "pid": 20,
                    "phase": "open_window_returned",
                    "request_id": 3,
                },
                self.marker("instance_enter", 300),
            ]
        )
        self.assertEqual(len(result["phases"]), 2)
        self.assertIsNone(result["innermostUnfinishedPhase"])
        self.assertTrue(result["nativeOpenCallReturned"])

    def test_recoverable_adapter_error_closes_its_span_before_next_adapter(self):
        for phase in ["device_request", "surface_configuration"]:
            with self.subTest(phase=phase):
                result = self.summarize(
                    [
                        self.marker("renderer_enter", 10),
                        self.marker(f"{phase}_enter", 20),
                        self.marker(f"{phase}_error", 25),
                        self.marker(
                            "ignored",
                            30,
                            message="  Adapter first (Vulkan) failed, trying next...",
                        ),
                        self.marker(f"{phase}_enter", 40),
                        self.marker(f"{phase}_return", 50),
                        self.marker("renderer_return", 60),
                        {
                            "nonce": self.correlation,
                            "source": "native",
                            "pid": 20,
                            "phase": "open_window_returned",
                            "request_id": 3,
                        },
                        {
                            "nonce": self.correlation,
                            "source": "transport",
                            "pid": 10,
                            "phase": "response_received",
                            "request_id": 3,
                            "response": "opened",
                        },
                    ]
                )
                self.assertEqual(result["unfinishedPhases"], [])
                self.assertTrue(result["firstOpenAcknowledged"])
                self.assertEqual(
                    result["completedPhaseDurations"],
                    [
                        {"phase": phase, "outcome": "error", "durationNs": "5"},
                        {"phase": phase, "outcome": "ok", "durationNs": "10"},
                        {"phase": "renderer", "outcome": "ok", "durationNs": "50"},
                    ],
                )

    def test_another_process_cannot_supply_a_return_marker(self):
        result = self.summarize(
            [
                self.marker("instance_enter", 100),
                self.marker("instance_return", 200, pid=21),
            ]
        )
        self.assertEqual(result["innermostUnfinishedPhase"], "instance")

    def test_foreign_correlation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "foreign correlation"):
            self.summarize(
                [self.marker("instance_enter", 100, nonce="another-observation")]
            )

    def test_unknown_or_unmatched_phase_is_rejected(self):
        for message in [
            "unknown_enter",
            "instance_return",
            "device_request_error",
            "instance_begin",
        ]:
            with (
                self.subTest(message=message),
                self.assertRaisesRegex(ValueError, "phase|Phase"),
            ):
                self.summarize([self.marker(message, 100)])

    def test_nonmonotonic_or_missing_native_clock_is_rejected(self):
        for elapsed in [99, "not-a-clock"]:
            with (
                self.subTest(elapsed=elapsed),
                self.assertRaisesRegex(ValueError, "clock"),
            ):
                self.summarize(
                    [
                        self.marker("instance_enter", 100),
                        self.marker("instance_return", elapsed),
                    ]
                )

    def test_capture_limits_are_explicitly_incomplete(self):
        result = self.summarize(
            [
                self.marker("instance_enter", 100),
                self.marker("instance_return", 200, phase="record_limit"),
            ]
        )
        self.assertFalse(result["captureComplete"])

    def test_missing_internal_markers_do_not_report_success(self):
        with self.assertRaisesRegex(ValueError, "No internal phase"):
            self.summarize([])

    def test_source_anchor_drift_or_ambiguity_is_rejected(self):
        for source in ["different code", "anchor anchor"]:
            with (
                self.subTest(source=source),
                self.assertRaisesRegex(ValueError, "exactly one pinned"),
            ):
                RUN.PREPARE.replace_once(source, "anchor", "instrumented")


if __name__ == "__main__":
    unittest.main()
