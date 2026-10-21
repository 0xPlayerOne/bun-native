import ctypes
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from kernel_counters import (
    RusageV0,
    linux_sample,
    parse_sched,
    sample_counters,
    summarize_counters,
    task_start,
)


def snapshot(time, value, identity="1:100", phase="idle", creation=1):
    return {
        "elapsedMs": time,
        "phase": phase,
        "processes": [
            {
                "pid": 1,
                "creationTime": creation,
                "kernelCounters": {
                    "provider": "test-kernel",
                    "status": "available",
                    "reason": "fixture",
                    "counters": [{"name": "wakeups", "scope": identity, "value": value}],
                },
            }
        ],
    }


class KernelCountersTests(unittest.TestCase):
    def test_rusage_v0_abi_layout(self):
        self.assertEqual(ctypes.sizeof(RusageV0), 96)
        self.assertEqual(RusageV0.pkg_idle_wkups.offset, 32)
        self.assertEqual(RusageV0.interrupt_wkups.offset, 40)

    def test_sched_parser_does_not_accept_switches_as_wakeups(self):
        self.assertEqual(parse_sched("nr_switches : 200\nnr_voluntary_switches : 199"), {})
        self.assertEqual(
            parse_sched("nr_wakeups : 12\nnr_wakeups_idle : 2"),
            {"nr_wakeups": 12, "nr_wakeups_idle": 2},
        )
        self.assertEqual(parse_sched("se.statistics.nr_wakeups : 17"), {"nr_wakeups": 17})
        with self.assertRaises(ValueError):
            parse_sched("nr_wakeups : 1\nnr_wakeups : 2")

    def test_disabled_collection_is_not_zero(self):
        with patch.dict(os.environ, {"BUNLY_KERNEL_COUNTERS": "0"}):
            self.assertEqual(sample_counters(os.getpid())["status"], "unavailable")

    def test_missing_linux_counters_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(linux_sample(1, Path(directory))["status"], "unavailable")

    def test_task_identity_handles_parentheses(self):
        text = "1 (name (with) spaces) S " + " ".join(["0"] * 18 + ["123"])
        self.assertEqual(task_start(text), "123")

    def test_counter_delta_and_rate_interval(self):
        result = summarize_counters([snapshot(0, 10), snapshot(100, 17), snapshot(200, 22)])
        self.assertEqual(result["metrics"][0]["observedDelta"], 12)
        self.assertEqual(result["metrics"][0]["sampledDurationMs"], 200)

    def test_phase_boundary_and_reused_identity_are_not_combined(self):
        self.assertEqual(
            summarize_counters([snapshot(0, 1), snapshot(100, 99, creation=2)])["status"],
            "unavailable",
        )
        self.assertEqual(
            summarize_counters([snapshot(0, 1), snapshot(100, 99, identity="1:200")])["status"],
            "unavailable",
        )
        self.assertEqual(
            summarize_counters([snapshot(0, 1), snapshot(100, 99, phase="active")])["status"],
            "unavailable",
        )

    def test_reset_and_single_snapshot_do_not_invent_deltas(self):
        self.assertEqual(summarize_counters([snapshot(0, 10)])["status"], "unavailable")
        result = summarize_counters([snapshot(0, 10), snapshot(100, 1)])
        self.assertEqual(result["status"], "unavailable")
        self.assertTrue(result["limitations"])
        with self.assertRaises(ValueError):
            summarize_counters([snapshot(100, 10), snapshot(0, 11)])

    def test_live_counter_provider_is_typed_or_explicitly_unavailable(self):
        with patch.dict(os.environ, {"BUNLY_KERNEL_COUNTERS": "1"}):
            result = sample_counters(os.getpid())
        self.assertIn(result["status"], ["available", "partial", "unavailable"])
        for counter in result["counters"]:
            self.assertIsInstance(counter["value"], int)
            self.assertGreaterEqual(counter["value"], 0)
        if sys.platform == "darwin":
            self.assertEqual(result["status"], "available", result)


if __name__ == "__main__":
    unittest.main()
