"""Exact-selection and attribution guards for the opt-in bridge phase join."""

import importlib.util
import unittest
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "bridge_phases", ROOT / "benchmarks/bridge-phases.py"
)
PHASES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PHASES)

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
FRAMES = ["windowId", "startedNanos", "renderNanos", "renderToPaintNanos", "nodes"]


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
            frames.append([1, started - 10, 2_000_000, 15_000_000, 1001])
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


if __name__ == "__main__":
    unittest.main()
