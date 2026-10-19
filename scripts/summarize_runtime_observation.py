"""Same-identity adjacent-delta idle accounting. No fabricated zeros for missing data."""

import argparse
import json
from pathlib import Path

from kernel_counters import summarize_counters


def summarize(report):
    samples = report["samples"]
    idle = [s for s in samples if s["phase"] == "idle"]
    matched_seconds = 0.0
    cpu_seconds = 0.0
    intervals = 0
    resets = 0
    for a, b in zip(samples, samples[1:], strict=False):
        if a["phase"] != "idle" or b["phase"] != "idle":
            continue
        seconds = (b["elapsedMs"] - a["elapsedMs"]) / 1000
        if seconds <= 0:
            raise ValueError("Non-monotonic observation")
        previous = {(p["pid"], p["creationTime"]): p for p in a["processes"]}
        paired = False
        for p in b["processes"]:
            old = previous.get((p["pid"], p["creationTime"]))
            if old is None:
                continue
            delta = p["cpuSeconds"] - old["cpuSeconds"]
            if delta < 0:
                resets += 1
                continue
            cpu_seconds += delta
            paired = True
        if paired:
            intervals += 1
            matched_seconds += seconds
    return {
        "observed": bool(intervals),
        "sampleCount": len(idle),
        "sampledDurationMs": matched_seconds * 1000,
        "cpuPercentOneCore": cpu_seconds / matched_seconds * 100 if intervals else None,
        "peakTreeRssBytes": max((s["rssBytes"] for s in idle), default=None),
        "peakTreeThreads": max((s["threads"] for s in idle), default=None),
        "counterResets": resets,
        "kernel": summarize_counters(idle),
        "accounting": "Matched live PID/creation identities only; RSS may double-count shared pages; CPU percent uses one core = 100%; no command polling in idle; kernel providers are not interchangeable",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    args = parser.parse_args()
    print(json.dumps(summarize(json.loads(Path(args.report).read_text()))))
