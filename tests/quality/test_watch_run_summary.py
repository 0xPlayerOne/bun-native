"""Guards for the retained watch-run summary; no app or native host is run."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "watch_run_summary", ROOT / "scripts/quality/watch-run-summary.py"
)
SUMMARY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUMMARY)


def row(index, ready=None, controller=100):
    value = {
        "editToReadyMs": 200.0 + index,
        "bundleMs": 20.0,
        "shutdownMs": 25.0,
        "mountMs": 140.0,
    }
    return {
        "ready": {"value": value},
        "trigger_to_ready_record_observed_ms": 210.0 + index,
        "trigger_to_initial_paint_observed_ms": 220.0 + index,
        "trigger_to_input_confirmed_paint_observed_ms": 350.0 + index,
        "process_snapshot": {
            "tree_rss_bytes": 1000 + index,
            "processes": [
                {"role": "cli-controller", "rss_bytes": controller + index},
                {"role": "cli-controller", "rss_bytes": 5},
                {"role": "native-host", "rss_bytes": 700},
            ],
        },
    }


def result(edits=4):
    return {
        "status": "passed",
        "framework": "solid",
        "planned_source_edits": edits,
        "generations": [row(index) for index in range(edits + 1)],
        "toolchain": {"bun": {"cliRevision": "1.4.4-canary.1+abc"}},
        "process_audit": {
            "maximum_live_native_hosts": 1,
            "maximum_live_application_processes": 1,
        },
    }


class WatchRunSummaryTests(unittest.TestCase):
    def test_percentile_interpolates(self):
        self.assertEqual(SUMMARY.percentile([1, 2, 3, 4], 0.5), 2.5)
        self.assertEqual(SUMMARY.percentile([7], 0.95), 7)

    def test_summarizes_edits_and_sums_only_controller_rss(self):
        summary = SUMMARY.summarize(result())
        self.assertEqual(summary["generations"], 5)
        self.assertEqual(summary["cliEditToReadyMs"]["count"], 4)
        self.assertEqual(summary["cliEditToReadyMs"]["median"], 202.5)
        self.assertEqual(summary["cliEditToReadyMs"]["maximum"], 204.0)
        self.assertEqual(
            summary["controllerRssBytes"],
            {"first": 105, "last": 109, "maximum": 109},
        )
        self.assertEqual(summary["treeRssBytes"]["last"], 1004)
        self.assertEqual(summary["bun"], "1.4.4-canary.1+abc")

    def test_rejects_unpassed_or_incomplete_results(self):
        failed = result()
        failed["status"] = "failed"
        with self.assertRaises(ValueError):
            SUMMARY.summarize(failed)
        short = result()
        short["generations"].pop()
        with self.assertRaises(ValueError):
            SUMMARY.summarize(short)
        with self.assertRaises(ValueError):
            SUMMARY.stats([])


if __name__ == "__main__":
    unittest.main()
