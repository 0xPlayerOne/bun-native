"""Native profiling markers carry no acceptance or authority."""

import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
spec = importlib.util.spec_from_file_location(
    "transport_observer", Path(__file__).resolve().parents[1] / "scripts/observe-process.py"
)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class PhaseMarkerTests(unittest.TestCase):
    def test_terminal_load_phases_are_diagnostics_not_authority(self):
        for phase in ("warmup", "ramp", "sustained", "recovery"):
            value = {"event": "bunly.terminal-load.phase", "schema": 1, "phase": phase}
            self.assertEqual(observer.phase_marker(value, False), phase)
            self.assertIsNone(observer.phase_marker(value, True))
            self.assertIsNone(observer.phase_marker({**value, "pid": 1}, False))
            self.assertIsNone(observer.phase_marker({**value, "schema": True}, False))
        self.assertIsNone(
            observer.phase_marker(
                {"event": "bunly.terminal-load.phase", "schema": 1, "phase": "arbitrary"}, False
            )
        )

    def test_stderr_requires_the_exact_diagnostic_schema_and_allowlisted_phase(self):
        for phase in ("transport-idle", "transport-work", "transport-complete"):
            value = {"event": "bunly.transport.phase", "schema": 1, "phase": phase}
            self.assertEqual(observer.phase_marker(value, False), phase)
            self.assertIsNone(observer.phase_marker(value, True))
        for value in [
            None,
            [],
            {"event": "phase", "phase": "transport-idle"},
            {"event": "bunly.transport.phase", "schema": True, "phase": "transport-idle"},
            {"event": "bunly.transport.phase", "schema": 1, "phase": "other"},
            {
                "event": "bunly.transport.phase",
                "schema": 1,
                "phase": "transport-idle",
                "passed": True,
            },
        ]:
            self.assertIsNone(observer.phase_marker(value, False))
        self.assertEqual(observer.phase_marker({"event": "phase", "phase": "idle"}, True), "idle")


if __name__ == "__main__":
    unittest.main()
