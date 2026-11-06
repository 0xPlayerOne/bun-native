"""Deterministic controls for the streaming-list soak summaries, not GUI evidence."""

import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "streaming_list", ROOT / "tests/native/streaming-list.py"
)
SOAK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOAK)


def frame(index, elapsed_ms, window=1, revision=None):
    return {
        "type": "frame",
        "window_id": window,
        "index": index,
        "tree_revision": revision if revision is not None else index,
        "node_count": 52,
        "elapsed_ns": str(int(elapsed_ms * 1e6)),
        "render_to_paint_ns": str(2_000_000),
    }


def application():
    return {
        "status": "passed",
        "framework": "Solid",
        "fixture": {"version": 1, "ticks": 2400},
        "final": {"digest": "23f90d78"},
        "stream": {
            "ticks": 2400,
            "durationMs": 10_000,
            "commits": 1000,
            "mutations": {"create": 1, "set": 2, "insert": 1, "remove": 1},
            "detachedTicks": 10,
            "detachedStructuralChanges": 0,
            "keys": ["up"],
            "updateToAck": {"count": 1},
        },
        "bounds": {
            "nodeBound": 51,
            "listenerBound": 14,
            "maxNodes": 51,
            "maxListeners": 14,
            "maxCallbacks": 15,
        },
    }


def report(framework="Solid", mode="development", digest="23f90d78"):
    result = application()
    result["framework"] = framework
    result["final"]["digest"] = digest
    return {
        "status": "passed",
        "scenario": f"{framework.lower()}-streaming-list",
        "framework": framework,
        "mode": mode,
        "hostProfile": "release",
        "host": {"sha256": "0" * 64},
        "system": {"platform": "Linux"},
        "renderer": {"gpu": {"is_software_emulated": True}},
        "application": result,
        "measurements": {
            "frames": SOAK.frame_summary([frame(1, 0), frame(2, 16)], 1),
            "batches": SOAK.batch_summary([], 1),
            "processes": {},
        },
    }


class StreamingListSummaryTest(unittest.TestCase):
    def test_distribution_uses_nearest_rank_and_nulls_when_empty(self):
        self.assertEqual(
            SOAK.distribution(range(1, 101)),
            {"count": 100, "p50": 50, "p95": 95, "p99": 99, "max": 100},
        )
        self.assertEqual(
            SOAK.distribution([]),
            {"count": 0, "p50": None, "p95": None, "p99": None, "max": None},
        )

    def test_frame_summary_filters_window_and_buckets_intervals(self):
        rows = [
            frame(1, 0),
            frame(2, 10),
            frame(3, 40),
            frame(4, 200),
            frame(5, 50, window=2),
            {"type": "batch_applied", "window_id": 1},
        ]
        summary = SOAK.frame_summary(rows, 1)
        self.assertEqual(summary["frames"], 4)
        self.assertEqual(summary["spanMs"], 200)
        self.assertEqual(summary["intervalMs"]["max"], 160)
        self.assertEqual(summary["intervalBuckets"]["<=16.7ms"], 1)
        self.assertEqual(summary["intervalBuckets"]["<=33.4ms"], 1)
        self.assertEqual(summary["intervalBuckets"][">100.0ms"], 1)
        self.assertEqual(summary["renderToPaintMs"]["p50"], 2)
        self.assertEqual(summary["distinctTreeRevisions"], 4)
        with self.assertRaisesRegex(RuntimeError, "monotonic"):
            SOAK.frame_summary([frame(1, 10), frame(2, 0)], 1)

    def test_series_summary_reports_growth_without_a_threshold(self):
        summary = SOAK.series_summary([{"v": value} for value in (1, 2, 3, 4, 9)], "v")
        self.assertEqual(summary["first"], 1)
        self.assertEqual(summary["max"], 9)
        self.assertEqual(summary["lastQuarterMedian"], 9)
        self.assertIsNone(SOAK.series_summary([{"v": None}], "v"))

    def test_validation_rejects_unbounded_or_moved_windows(self):
        self.assertTrue(SOAK.validate_application(application(), "Solid"))
        for mutate, message in (
            (lambda value: value["bounds"].update(maxNodes=52), "bound"),
            (lambda value: value["bounds"].update(maxListeners=15), "bound"),
            (lambda value: value["stream"].update(ticks=10), "complete"),
            (
                lambda value: value["stream"].update(detachedStructuralChanges=1),
                "moved",
            ),
            (lambda value: value["stream"].update(detachedTicks=0), "moved"),
            (lambda value: value.update(framework="React"), "framework"),
        ):
            value = copy.deepcopy(application())
            mutate(value)
            with self.assertRaisesRegex(RuntimeError, message):
                SOAK.validate_application(value, "Solid")

    def test_baseline_requires_one_replayed_stream_across_adapters(self):
        summary = SOAK.baseline([report(), report("React", "aot")])
        self.assertEqual(summary["finalDigest"], "23f90d78")
        self.assertEqual(
            [(run["framework"], run["mode"]) for run in summary["runs"]],
            [("Solid", "development"), ("React", "aot")],
        )
        with self.assertRaisesRegex(RuntimeError, "different streams"):
            SOAK.baseline([report(), report("React", digest="ffffffff")])
        failed = report()
        failed["status"] = "failed"
        with self.assertRaisesRegex(RuntimeError, "did not pass"):
            SOAK.baseline([failed])
        with self.assertRaisesRegex(RuntimeError, "at least one"):
            SOAK.baseline([])

    def test_baseline_rejects_mixed_fixture_versions_with_one_digest(self):
        newer = report("React")
        newer["application"]["fixture"]["version"] = 2
        with self.assertRaisesRegex(RuntimeError, "different streams"):
            SOAK.baseline([report(), newer])
        summary = SOAK.baseline([report()])
        self.assertEqual(summary["fixtureVersion"], 1)
        self.assertEqual(summary["fixture"], {"version": 1, "ticks": 2400})

    def test_validation_requires_a_passed_fixture_status(self):
        value = application()
        value["status"] = "failed"
        with self.assertRaisesRegex(RuntimeError, "framework"):
            SOAK.validate_application(value, "Solid")

    def test_frame_summary_reports_null_rates_without_two_frames(self):
        for rows in ([], [frame(1, 5)]):
            summary = SOAK.frame_summary(rows, 1)
            self.assertEqual(summary["spanMs"], 0)
            self.assertIsNone(summary["framesPerSecond"])
            self.assertEqual(summary["intervalMs"]["count"], 0)
            self.assertEqual(sum(summary["intervalBuckets"].values()), 0)
        boundary = SOAK.frame_summary([frame(1, 0), frame(2, 16.7)], 1)
        self.assertEqual(boundary["intervalBuckets"]["<=16.7ms"], 1)
        self.assertAlmostEqual(boundary["framesPerSecond"], 1000 / 16.7)

    def test_batch_summary_filters_window_and_converts_preflight(self):
        rows = [
            {
                "type": "batch_applied",
                "window_id": 1,
                "operation_count": 3,
                "text_bytes": 10,
                "preflight_nanos": 2000,
            },
            {
                "type": "batch_applied",
                "window_id": 2,
                "operation_count": 99,
                "text_bytes": 99,
                "preflight_nanos": 99_000,
            },
            {"type": "frame", "window_id": 1},
        ]
        summary = SOAK.batch_summary(rows, 1)
        self.assertEqual(summary["batches"], 1)
        self.assertEqual(summary["operations"]["max"], 3)
        self.assertEqual(summary["textBytes"]["p50"], 10)
        self.assertEqual(summary["preflightUs"]["p50"], 2)


if __name__ == "__main__":
    unittest.main()
