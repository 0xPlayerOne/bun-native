"""Exact-selection and attribution guards for the opt-in bridge phase join."""

import json
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from scripts.quality.native_harness import bridge_phases as PHASES

ROOT = Path(__file__).resolve().parents[2]

COLUMNS = [
    "id",
    "windowId",
    "operations",
    "startedNanos",
    "prepareNanos",
    "applyNanos",
    "replyEnqueueNanos",
    "rendersBefore",
]
FRAMES = [
    "windowId",
    "startedNanos",
    "renderNanos",
    "renderToPaintNanos",
    "nodes",
    "culledNodes",
]


def fixture():
    batches = [[10, 1, 6, 0, 1, 1, 1, 0]]
    renders = 0
    request = 30
    started = 1_000
    frames = []
    for index in range(PHASES.WARMUPS + PHASES.INDIVIDUAL + PHASES.BATCHES):
        operations = 100 if index >= PHASES.WARMUPS + PHASES.INDIVIDUAL else 1
        # One render before every 100th measured individual request.
        if (
            index > PHASES.WARMUPS
            and (index - PHASES.WARMUPS) % 100 == 0
            and operations == 1
        ):
            renders += 1
            frames.append([1, started - 10, 2_000_000, 15_000_000, 1001, 0])
        batches.append(
            [request, 1, operations, started, 100_000, 20_000, 10_000, renders]
        )
        request += 1
        started += 1_000
    # Another window's work must not enter the window-1 selection.
    batches.insert(500, [9_999, 2, 1, started, 1, 1, 1, renders])
    acks = [0.5] * PHASES.INDIVIDUAL
    for index in range(100, PHASES.INDIVIDUAL, 100):
        acks[index] = 20.0
    result = {
        "status": "passed",
        "individual": {"samplesMs": acks},
        "batchesOf100": {"samplesMs": [1.0] * PHASES.BATCHES},
    }
    trace = {
        "schemaVersion": 1,
        "batchColumns": COLUMNS,
        "frameColumns": FRAMES,
        "renders": renders,
        "droppedBatches": 0,
        "droppedFrames": 0,
        "batches": batches,
        "frames": frames,
    }
    return result, trace


class BridgePhaseTests(unittest.TestCase):
    def test_selects_exact_phase_and_attributes_render_delayed_acknowledgements(self):
        result, trace = fixture()
        report = PHASES.analyze(result, trace)
        individual = report["individual"]
        self.assertEqual(individual["ackMs"]["count"], 1000)
        self.assertAlmostEqual(individual["prepareMs"]["p50"], 0.1)
        self.assertAlmostEqual(individual["nativeUiThreadMs"]["total"], 130.0)
        self.assertEqual(individual["rendersBetweenConsecutiveRequests"], 9)
        split = report["individualAckByPrecedingRender"]
        self.assertEqual(split["withRender"]["count"], 9)
        self.assertEqual(split["withRender"]["p50"], 20.0)
        self.assertEqual(split["withoutRender"]["max"], 0.5)
        frames = report["framesDuringIndividualPhase"]
        self.assertEqual(frames["count"], 9)
        self.assertEqual(frames["nodes"], [1001])
        self.assertAlmostEqual(frames["renderToPaintMs"]["p50"], 15.0)
        self.assertEqual(report["batchesOf100"]["ackMs"]["count"], 10)

    def test_rejects_incomplete_or_reshaped_captures(self):
        def dropped(trace):
            trace["droppedFrames"] = 1

        def missing_individual(trace):
            del trace["batches"][300]

        def missing_batch(trace):
            trace["batches"].pop()

        def gap(trace):
            trace["batches"][-1][0] += 5

        def schema(trace):
            trace["schemaVersion"] = 2

        for mutate in [dropped, missing_individual, missing_batch, gap, schema]:
            with self.subTest(mutation=mutate.__name__):
                result, trace = fixture()
                trace = deepcopy(trace)
                mutate(trace)
                with self.assertRaises(SystemExit):
                    PHASES.analyze(result, trace)

    def test_rejects_incomplete_bridge_samples(self):
        result, trace = fixture()
        result["individual"]["samplesMs"].pop()
        with self.assertRaises(SystemExit):
            PHASES.analyze(result, trace)

    def test_rejects_traces_without_the_measured_phase_shape(self):
        def no_batches(trace):
            for row in trace["batches"]:
                if row[2] == 100:
                    row[2] = 1

        def too_few_requests(trace):
            del trace["batches"][1:40]

        def multi_operation_warmup(trace):
            trace["batches"][5][2] = 2

        for mutate, message in [
            (no_batches, "measured individual phase"),
            (too_few_requests, "measured individual phase"),
            (multi_operation_warmup, "20 warmups"),
        ]:
            with self.subTest(mutation=mutate.__name__):
                result, trace = fixture()
                mutate(trace)
                with self.assertRaisesRegex(SystemExit, message):
                    PHASES.analyze(result, trace)

    def test_frames_outside_window_or_phase_or_without_paint_are_excluded(self):
        result, trace = fixture()
        individual_start = trace["batches"][1 + PHASES.WARMUPS][3]
        trace["frames"] += [
            [2, individual_start + 5, 9_000_000, 9_000_000, 7, 0],
            [1, 0, 9_000_000, 9_000_000, 7, 0],
            [1, individual_start + 5, 3_000_000, None, 1001, 0],
        ]
        frames = PHASES.analyze(result, trace)["framesDuringIndividualPhase"]
        self.assertEqual(frames["count"], 10)
        self.assertEqual(frames["nodes"], [1001])
        self.assertEqual(frames["renderMs"]["max"], 3.0)
        self.assertEqual(frames["renderToPaintMs"]["count"], 9)

    def test_empty_summaries_have_no_quantiles(self):
        self.assertEqual(
            PHASES.summary([]),
            {
                "count": 0,
                "p50": None,
                "p95": None,
                "p99": None,
                "max": None,
                "total": 0,
            },
        )
        self.assertEqual(PHASES.percentile([3, 1, 2], 0.5), 2)

    def test_cli_joins_files_and_requires_a_passed_result(self):
        result, trace = fixture()
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory, "result.json")
            trace_path = Path(directory, "trace.json")
            trace_path.write_text(json.dumps(trace))

            def run():
                return subprocess.run(
                    [
                        sys.executable,
                        str(ROOT / "benchmarks/bridge-phases.py"),
                        "--result",
                        str(result_path),
                        "--trace",
                        str(trace_path),
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )

            result_path.write_text(json.dumps(result))
            joined = run()
            self.assertEqual(joined.returncode, 0, joined.stderr)
            self.assertEqual(json.loads(joined.stdout), PHASES.analyze(result, trace))
            result["status"] = "failed"
            result_path.write_text(json.dumps(result))
            failed = run()
            self.assertEqual(failed.returncode, 1)
            self.assertIn("bridge result did not pass", failed.stderr)


if __name__ == "__main__":
    unittest.main()
