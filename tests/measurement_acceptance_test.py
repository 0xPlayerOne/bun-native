"""Synthetic accounting and actual registered-process identity checks."""

import importlib.util
import os
import sys
import unittest
from pathlib import Path

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from registered_app import verify
from summarize_runtime_observation import summarize


def sample(t, cpu, creation=1):
    return {
        "elapsedMs": t,
        "phase": "idle",
        "rssBytes": 10,
        "threads": 2,
        "processes": [{"pid": 1, "creationTime": creation, "cpuSeconds": cpu}],
    }


class MeasurementTests(unittest.TestCase):
    def test_no_samples_is_not_zero(self):
        result = summarize({"samples": []})
        self.assertFalse(result["observed"])
        self.assertIsNone(result["cpuPercentOneCore"])

    def test_cpu_uses_matched_identity_and_elapsed_wall_time(self):
        result = summarize({"samples": [sample(0, 1), sample(1000, 1.1), sample(2000, 1.2)]})
        self.assertAlmostEqual(result["cpuPercentOneCore"], 10)
        self.assertEqual(result["sampledDurationMs"], 2000)

    def test_reused_pid_is_not_a_delta(self):
        result = summarize({"samples": [sample(0, 1), sample(1000, 9, creation=2)]})
        self.assertIsNone(result["cpuPercentOneCore"])

    def test_counter_resets_are_reported(self):
        result = summarize({"samples": [sample(0, 2), sample(1000, 1)]})
        self.assertEqual(result["counterResets"], 1)

    def test_real_process_executable_match(self):
        # macOS framework Python may exec a binary distinct from its launcher.
        # Keep the production exact-path check; use the actual OS executable here.
        process, created = verify(os.getpid(), psutil.Process().exe())
        self.assertEqual(process.pid, os.getpid())
        self.assertGreater(created, 0)
        with self.assertRaises(ValueError):
            verify(os.getpid(), __file__)

    def test_latency_validator_rejects_missing_input_and_dropped_bytes(self):
        spec = importlib.util.spec_from_file_location(
            "latency", Path(__file__).resolve().parents[1] / "scripts/qualify-workbench-latency.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        value = {
            "input": [{"handlerToFrame": 1, "eventToFrame": 2}],
            "trusted": 1,
            "writes": [{"bytes": 2, "callbackMs": 1}],
        }
        self.assertEqual(module.validate_trial(value, 1, 1, 2), value)
        with self.assertRaises(ValueError):
            module.validate_trial(value, 2, 1, 2)
        with self.assertRaises(ValueError):
            module.validate_trial(value, 1, 1, 3)


if __name__ == "__main__":
    unittest.main()
