#!/usr/bin/env python3
"""Recompute the event-routing paired bootstrap from an archived raw report."""

import gzip
import json
import math
import random
import statistics
import sys
from pathlib import Path

SCENARIOS = ("empty", "off-path", "target", "mixed")
MODES = ("development", "aot")
VARIANTS = ("baseline", "candidate")


def analyze(report):
    environment = report["environment"]
    count = environment["pairs"]
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 20:
        raise ValueError("invalid pair count")
    runs = report["runs"]
    if len(runs) != count * len(MODES) * len(VARIANTS):
        raise ValueError("incomplete run count")
    grouped = {}
    expected_order = [
        (mode, pair, variant)
        for mode in MODES
        for pair in range(count)
        for variant in (VARIANTS if pair % 2 == 0 else VARIANTS[::-1])
    ]
    for run, expected in zip(runs, expected_order, strict=True):
        identity = (run["mode"], run["pair"], run["variant"])
        if identity != expected:
            raise ValueError("incorrect or duplicated pair order")
        data = run["data"]
        if data["revision"] != environment["revision"]:
            raise ValueError("Bun revision mismatch")
        entries = data["results"]
        if len(entries) != len(SCENARIOS) or {x["scenario"] for x in entries} != set(
            SCENARIOS
        ):
            raise ValueError("invalid scenarios")
        for item in entries:
            samples = item["samplesNs"]
            if len(samples) != 25 or any(
                isinstance(x, bool)
                or not isinstance(x, (int, float))
                or not math.isfinite(x)
                or x <= 0
                for x in samples
            ):
                raise ValueError("invalid samples")
            measured = statistics.median(samples)
            if measured != item["medianNs"]:
                raise ValueError("incorrect process median")
            grouped[identity + (item["scenario"],)] = measured
    summary = {}
    for mode in MODES:
        summary[mode] = {}
        for scenario in SCENARIOS:
            baseline = [grouped[(mode, p, "baseline", scenario)] for p in range(count)]
            delta = [
                grouped[(mode, p, "candidate", scenario)] - baseline[p]
                for p in range(count)
            ]
            # A process pair, not an inner timing batch, is the resampling unit.
            rng = random.Random(673)
            resampled = sorted(
                statistics.median(rng.choices(delta, k=count)) for _ in range(10000)
            )
            summary[mode][scenario] = {
                "pairs": count,
                "baselineMedianNs": statistics.median(baseline),
                "candidateMinusBaselineMedianNs": statistics.median(delta),
                "interval95Ns": [resampled[250], resampled[9749]]
                if count >= 3
                else None,
                "fasterPairs": sum(value < 0 for value in delta),
            }
    return {"environment": environment, "summary": summary}


def main():
    source = Path(sys.argv[1])
    content = (
        gzip.decompress(source.read_bytes())
        if source.suffix == ".gz"
        else source.read_bytes()
    )
    print(json.dumps(analyze(json.loads(content)), indent=2))


if __name__ == "__main__":
    main()
