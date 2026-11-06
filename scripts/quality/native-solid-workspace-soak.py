#!/usr/bin/env python3
"""Independently check a native Solid workspace long-session report (#250).

The fixture asserts exact per-round ownership itself. This check recomputes
the expected totals from the fixed round plan, requires zero final resources
and an observed owned host, and summarizes the recorded memory samples. The
samples are single-run observations, not a leak-freedom or capacity claim.
"""

import json
import sys
from pathlib import Path

ROUNDS = 60
SAMPLE_EVERY = 10
SENDS_PER_ROUND = 16
# Per four prompts: two complete (8 + 8 timers), one cancelled after three
# updates (4 timers) and one switched away after two updates (3 timers).
TIMERS_PER_FOUR_SENDS = 23
RESOURCE_KEYS = {
    "windows",
    "nodes",
    "callbacks",
    "queuedTransactions",
    "queuedCallbacks",
    "activeCallbacks",
    "serviceRequests",
}


def check(report):
    replies = ROUNDS * SENDS_PER_ROUND
    expected = {
        "schemaVersion": 1,
        "status": "passed",
        "scenario": "solid-workspace-soak",
        "rounds": ROUNDS,
        "replies": replies,
        "completedReplies": replies // 2,
        "cancelledReplies": replies // 2,
        "ignoredStaleCallbacks": replies // 4,
        "scheduledTimers": replies // 4 * TIMERS_PER_FOUR_SENDS,
    }
    for key, value in expected.items():
        if report.get(key) != value:
            raise AssertionError(f"{key}: expected {value!r}, got {report.get(key)!r}")
    final = report["final"]
    if set(final["application"]) != RESOURCE_KEYS or any(final["application"].values()):
        raise AssertionError(f"Final public resources must be zero: {final}")
    if final["localWork"] != {
        "disposed": True,
        "pendingTimers": 0,
        "activeReplies": 0,
        "completedReplies": replies // 2,
        "cancelledReplies": replies // 2,
    }:
        raise AssertionError(f"Final local work must be released: {final}")
    if report["system"]["platform"] != "linux":
        raise AssertionError("This check covers the Linux native host only")
    durations = report["roundDurationsMs"]
    if len(durations) != ROUNDS or min(durations) <= 0:
        raise AssertionError("Every round must record a positive duration")
    if report["commits"] <= report["actions"] // 2:
        raise AssertionError("Native acknowledgements must cover the driven actions")
    samples = report["samples"]
    rounds = [sample["round"] for sample in samples]
    if rounds != list(range(0, ROUNDS + 1, SAMPLE_EVERY)):
        raise AssertionError(f"Unexpected sample rounds: {rounds}")
    for sample in samples:
        if not isinstance(sample["hostRssKiB"], int) or sample["hostRssKiB"] <= 0:
            raise AssertionError("Every sample must observe the owned native host RSS")
        if sample["objectCount"] <= 0 or sample["bunRssBytes"] <= 0:
            raise AssertionError("Every sample must record live heap and RSS")
    first, warm, last = samples[0], samples[1], samples[-1]
    return {
        "rounds": ROUNDS,
        "replies": replies,
        "actions": report["actions"],
        "commits": report["commits"],
        "elapsedMs": round(report["elapsedMs"]),
        "medianRoundMs": round(sorted(durations)[ROUNDS // 2], 2),
        "objectCount": [first["objectCount"], warm["objectCount"], last["objectCount"]],
        "heapSize": [first["heapSize"], warm["heapSize"], last["heapSize"]],
        "bunRssBytes": [first["bunRssBytes"], warm["bunRssBytes"], last["bunRssBytes"]],
        "hostRssKiB": [first["hostRssKiB"], warm["hostRssKiB"], last["hostRssKiB"]],
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: native-solid-workspace-soak.py SOAK_RESULT_JSON")
    report = json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(check(report), indent=2))


if __name__ == "__main__":
    main()
