"""Join one bridge result with its opt-in native phase trace (#297).

The phase trace (BUN_NATIVE_PHASE_TRACE) is a separate instrumented run. Its
numbers must not be merged into the uninstrumented bridge baseline.
"""

import argparse
import json
import math
from itertools import pairwise
from pathlib import Path

INDIVIDUAL = 1000
WARMUPS = 20
BATCHES = 10


def fail(message):
    raise SystemExit(f"bridge-phases: {message}")


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[math.ceil(len(ordered) * fraction) - 1] if ordered else None


def summary(values):
    return {
        "count": len(values),
        "p50": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "p99": percentile(values, 0.99),
        "max": max(values) if values else None,
        "total": sum(values),
    }


def select(batches):
    """Return the exact measured individual and batch-of-100 records."""
    window = [row for row in batches if row["windowId"] == 1]
    first_batch = next(
        (index for index, row in enumerate(window) if row["operations"] == 100), None
    )
    if first_batch is None or first_batch < INDIVIDUAL + WARMUPS:
        fail("trace does not contain the measured individual phase")
    individual = window[first_batch - INDIVIDUAL : first_batch]
    warmups = window[first_batch - INDIVIDUAL - WARMUPS : first_batch - INDIVIDUAL]
    batched = window[first_batch : first_batch + BATCHES]
    if any(row["operations"] != 1 for row in warmups + individual):
        fail("individual phase is not 20 warmups plus 1,000 single-operation batches")
    if len(batched) != BATCHES or any(row["operations"] != 100 for row in batched):
        fail("batch phase is not ten 100-operation batches")
    ids = [row["id"] for row in individual + batched]
    if ids != list(range(ids[0], ids[0] + len(ids))):
        fail("selected request IDs are not contiguous")
    return individual, batched


def rows(trace, key, columns):
    expected = trace[columns]
    return [dict(zip(expected, row, strict=True)) for row in trace[key]]


def analyze(result, trace):
    if trace.get("schemaVersion") != 1:
        fail("unsupported phase trace schema")
    if trace["droppedBatches"] or trace["droppedFrames"]:
        fail("phase trace dropped records; the bounded capture is incomplete")
    batches = rows(trace, "batches", "batchColumns")
    frames = rows(trace, "frames", "frameColumns")
    individual, batched = select(batches)
    acks = result["individual"]["samplesMs"]
    batch_acks = result["batchesOf100"]["samplesMs"]
    if len(acks) != INDIVIDUAL or len(batch_acks) != BATCHES:
        fail("bridge result does not contain the complete sample sets")

    def phase(records, samples):
        native = [
            (row["prepareNanos"] + row["applyNanos"] + row["replyEnqueueNanos"]) / 1e6
            for row in records
        ]
        renders = [
            following["rendersBefore"] - row["rendersBefore"]
            for row, following in pairwise(records)
        ]
        return {
            "ackMs": summary(samples),
            "prepareMs": summary([row["prepareNanos"] / 1e6 for row in records]),
            "applyMs": summary([row["applyNanos"] / 1e6 for row in records]),
            "replyEnqueueMs": summary(
                [row["replyEnqueueNanos"] / 1e6 for row in records]
            ),
            "nativeUiThreadMs": summary(native),
            "requestAndReplyTransportMs": summary(
                [ack - inside for ack, inside in zip(samples, native, strict=True)]
            ),
            "rendersBetweenConsecutiveRequests": sum(renders),
            "renderFreeGaps": renders.count(0),
        }

    # Renders that ran after request i was replied and before request i+1 was
    # dispatched delay request i+1 on the shared UI thread.
    preceded = []
    for previous, row, ack in zip(individual, individual[1:], acks[1:], strict=False):
        preceded.append((row["rendersBefore"] - previous["rendersBefore"], ack))
    start, end = individual[0]["startedNanos"], individual[-1]["startedNanos"]
    window_frames = [
        frame
        for frame in frames
        if frame["windowId"] == 1 and start <= frame["startedNanos"] <= end
    ]
    painted = [
        frame["renderToPaintNanos"] / 1e6
        for frame in window_frames
        if frame["renderToPaintNanos"] is not None
    ]
    return {
        "individual": phase(individual, acks),
        "batchesOf100": phase(batched, batch_acks),
        "individualAckByPrecedingRender": {
            "withRender": summary([ack for count, ack in preceded if count]),
            "withoutRender": summary([ack for count, ack in preceded if not count]),
        },
        "framesDuringIndividualPhase": {
            "count": len(window_frames),
            "nodes": sorted({frame["nodes"] for frame in window_frames}),
            "renderMs": summary(
                [frame["renderNanos"] / 1e6 for frame in window_frames]
            ),
            "renderToPaintMs": summary(painted),
        },
        "totalRenders": trace["renders"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--trace", type=Path, required=True)
    arguments = parser.parse_args()
    result = json.loads(arguments.result.read_text())
    if result.get("status") != "passed":
        fail("bridge result did not pass")
    print(
        json.dumps(analyze(result, json.loads(arguments.trace.read_text())), indent=2)
    )
