"""Phase-triggered diagnostics do not interpret wall time as native progress."""

import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from capture_cef_shutdown import Capture, finish_capture
from cef_shutdown_trigger import ShutdownTrigger

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

spec = importlib.util.spec_from_file_location("phase_observer", SCRIPTS / "observe-process.py")
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


def phase(state, **extra):
    return {"event": "bunly.host.shutdown-phase", "phase": "cef-shutdown", "state": state, **extra}


class ShutdownTriggerTests(unittest.TestCase):
    def test_elapsed_launch_time_alone_never_arms_phase_capture(self):
        trigger = ShutdownTrigger(0.25)
        self.assertFalse(trigger.due(100000))
        self.assertEqual(trigger.report(0)["status"], "phase-not-observed")
        trigger.observe(phase("start"), 100)
        self.assertFalse(trigger.due(100.249))
        self.assertTrue(trigger.due(100.25))
        self.assertEqual(trigger.report(90)["startElapsedMs"], 10000)

    def test_completion_before_dispatch_cannot_be_reinterpreted_as_a_stall(self):
        trigger = ShutdownTrigger(0.25)
        trigger.observe(phase("start"), 100)
        trigger.observe(phase("complete", durationMs=100), 100.1)
        self.assertFalse(trigger.due(200))
        self.assertEqual(trigger.report(90)["status"], "phase-completed")
        with self.assertRaisesRegex(ValueError, "phase-no-longer-pending"):
            trigger.require_pending()

    def test_unrelated_phases_never_arm_the_capture(self):
        trigger = ShutdownTrigger(0)
        for event in [
            {"event": "phase", "phase": "cef-shutdown", "state": "start"},
            {**phase("start"), "phase": "host-release"},
        ]:
            trigger.observe(event, 100)
        self.assertFalse(trigger.due(200))

    def test_malformed_duplicates_and_reordered_receipts_fail_closed(self):
        for events in [
            [phase("complete", durationMs=1)],
            [phase("start"), phase("start")],
            [phase("start", extra=True)],
            [phase("start"), phase("complete", durationMs=-1)],
            [phase("start"), phase("complete", durationMs=True)],
            [phase("start"), phase("complete", durationMs=0), phase("complete", durationMs=0)],
        ]:
            with self.subTest(events=events):
                trigger = ShutdownTrigger(0)
                for index, event in enumerate(events):
                    trigger.observe(event, 100 + index)
                self.assertFalse(trigger.due(200))
                self.assertEqual(trigger.report(90)["status"], "malformed-phase")

    def test_nonfinite_or_backwards_receipt_clock_cannot_arm_capture(self):
        for clock in [float("nan"), float("inf"), -1, True]:
            trigger = ShutdownTrigger(0)
            trigger.observe(phase("start"), clock)
            self.assertFalse(trigger.due(100))
            self.assertEqual(trigger.report(0)["status"], "malformed-phase")
        trigger = ShutdownTrigger(0)
        trigger.observe(phase("start"), 100)
        self.assertFalse(trigger.due(99))
        trigger.observe(phase("complete", durationMs=1), 99)
        self.assertEqual(trigger.report(0)["status"], "malformed-phase")

    def test_delay_is_finite_bounded_and_not_a_watchdog_configuration(self):
        for value in [-1, 5.001, float("nan"), float("inf"), True, "0"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                ShutdownTrigger(value)
        self.assertEqual(ShutdownTrigger(5).report(0)["delayMs"], 5000)

    def test_phase_capture_has_one_worker_and_no_work_before_the_trigger(self):
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(Path(directory), Path(directory), "host", 40, shutdown_after=0.25)
            with patch("capture_cef_shutdown.threading.Thread") as worker:
                capture(None)
                worker.assert_not_called()
                capture.on_shutdown_phase(phase("start"), 10)
                with patch("capture_cef_shutdown.time.monotonic", return_value=10.2):
                    capture(None)
                worker.assert_not_called()
                with patch("capture_cef_shutdown.time.monotonic", return_value=10.3):
                    capture(None)
                    capture(None)
                worker.assert_called_once()
                worker.return_value.start.assert_called_once()

    def test_finished_phase_never_starts_a_capture_even_after_delay(self):
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(Path(directory), Path(directory), "host", 40, shutdown_after=0)
            capture.on_shutdown_phase(phase("start"), 10)
            capture.on_shutdown_phase(phase("complete", durationMs=30), 10.03)
            with patch("capture_cef_shutdown.threading.Thread") as worker:
                capture(None)
                worker.assert_not_called()
            result = finish_capture(capture)
            self.assertFalse(result["captureComplete"])
            self.assertEqual(result["status"], "phase-ended-before-capture")
            self.assertEqual(result["trigger"]["status"], "phase-completed")

    def test_phase_completion_during_read_retains_unqualified_partial_evidence(self):
        from types import SimpleNamespace

        target = (
            20,
            1.0,
            SimpleNamespace(unique_id=5, executable_uuid=b"x" * 16),
            Path("helper"),
            (),
            "hash",
        )
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(Path(directory), Path(directory), "host", 40, shutdown_after=0)
            capture.on_shutdown_phase(phase("start"), 10)

            def read(_pid):
                capture.on_shutdown_phase(phase("complete", durationMs=10), 10.01)
                return [{"runState": 3}]

            with (
                patch("capture_cef_shutdown.verified_target", return_value=target),
                patch("capture_cef_shutdown.read_threads", side_effect=read),
            ):
                capture.run(None)
            self.assertNotIn("identityRevalidated", capture.records[0])
            self.assertIn("phase-no-longer-pending", capture.records[-1]["failure"])

    def test_completed_phase_rejects_before_target_inspection(self):
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(Path(directory), Path(directory), "host", 40, shutdown_after=0)
            capture.on_shutdown_phase(phase("start"), 10)
            capture.on_shutdown_phase(phase("complete", durationMs=1), 10.001)
            with (
                patch("capture_cef_shutdown.verified_target") as target,
                patch("capture_cef_shutdown.read_threads") as read,
            ):
                capture.run(None)
            target.assert_not_called()
            read.assert_not_called()
            self.assertIn("phase-no-longer-pending", capture.records[0]["failure"])

    def test_pending_phase_does_not_bypass_target_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(Path(directory), Path(directory), "network", 40, shutdown_after=0)
            capture.on_shutdown_phase(phase("start"), 10)
            with (
                patch(
                    "capture_cef_shutdown.verified_target",
                    side_effect=ValueError("unverified-owned-root"),
                ),
                patch("capture_cef_shutdown.read_threads") as read,
            ):
                capture.run(None)
            read.assert_not_called()
            self.assertIn("unverified-owned-root", capture.records[0]["failure"])

    def test_capture_report_refreshes_phase_after_worker_join(self):
        from unittest.mock import Mock

        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(Path(directory), Path(directory), "network", 40, shutdown_after=0)
            capture.on_shutdown_phase(phase("start"), 10)
            capture.worker = Mock()
            capture.worker.is_alive.return_value = False
            capture.worker.join.side_effect = lambda **_kw: capture.on_shutdown_phase(
                phase("start"), 11
            )
            capture.records = [
                {"index": index, "identityRevalidated": True, "phasePendingRevalidated": True}
                for index in range(10)
            ]
            report = finish_capture(capture)
            self.assertFalse(report["captureComplete"])
            self.assertEqual(report["trigger"]["status"], "malformed-phase")

    def test_pending_phase_complete_sequence_has_distinct_schema_and_relative_times(self):
        from types import SimpleNamespace
        from unittest.mock import Mock

        target = (
            20,
            1.0,
            SimpleNamespace(unique_id=5, executable_uuid=b"x" * 16),
            Path("helper"),
            (),
            "hash",
        )
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(Path(directory), Path(directory), "host", 40, shutdown_after=0)
            capture.on_shutdown_phase(phase("start"), 10)
            capture.stop.wait = Mock(return_value=False)
            with (
                patch("capture_cef_shutdown.verified_target", return_value=target),
                patch("capture_cef_shutdown.read_threads", return_value=[{"runState": 3}]),
                patch("capture_cef_shutdown.time.monotonic", return_value=10.1),
            ):
                capture.run(None)
            capture.worker = Mock()
            capture.worker.is_alive.return_value = False
            report = finish_capture(capture)
            self.assertEqual(report["schema"], 2)
            self.assertTrue(report["captureComplete"])
            self.assertEqual(len(report["records"]), 10)
            self.assertTrue(all(row["phasePendingRevalidated"] for row in report["records"]))
            self.assertAlmostEqual(report["records"][0]["shutdownElapsedMs"], 100)


class PhaseObserverTests(unittest.TestCase):
    def test_only_admitted_stderr_native_receipts_reach_main_thread_hook(self):
        main = threading.get_ident()
        received = []
        start, complete = json.dumps(phase("start")), json.dumps(phase("complete", durationMs=1))
        code = f"import sys; print({start!r}); print({start!r}, file=sys.stderr); print({complete!r}, file=sys.stderr)"
        report = observer.observe(
            [sys.executable, "-c", code],
            timeout=5,
            phase_observer=lambda event, at: received.append((event, at, threading.get_ident())),
        )
        self.assertEqual(report["exitCode"], 0)
        self.assertIsNone(report["observerFailure"])
        self.assertEqual(
            [event for event, _, _ in received], [phase("start"), phase("complete", durationMs=1)]
        )
        self.assertTrue(all(thread == main for _, _, thread in received))
        self.assertLessEqual(received[0][1], received[1][1])

    def test_callback_failure_uses_existing_owned_cleanup_and_keeps_receipt(self):
        def fail(_event, _at):
            raise RuntimeError("controlled phase hook failure")

        code = f"import sys,time; print({json.dumps(phase('start'))!r}, file=sys.stderr, flush=True); time.sleep(30)"
        report = observer.observe([sys.executable, "-c", code], timeout=5, phase_observer=fail)
        self.assertEqual(report["observerFailure"], "phase-observer-failed")
        self.assertTrue(report["cancelled"])
        self.assertEqual(report["cleanupSurvivors"], [])
        self.assertEqual(len(report["nativeDiagnostics"]), 1)

    def test_overflowed_native_event_never_reaches_diagnostic_hook(self):
        received = []
        code = f"import sys; print({json.dumps(phase('start'))!r}, file=sys.stderr)"
        with patch.object(observer, "NATIVE_DIAGNOSTIC_COUNT", 0):
            report = observer.observe(
                [sys.executable, "-c", code],
                timeout=5,
                phase_observer=lambda event, at: received.append(event),
            )
        self.assertTrue(report["outputOverflow"])
        self.assertEqual(received, [])
