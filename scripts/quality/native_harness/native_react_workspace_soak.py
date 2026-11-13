"""Independently check a native React workspace long-session report (#248).

The fixture asserts exact per-round ownership itself. This check recomputes
the expected totals from the fixed round plan, requires zero final resources
and an observed owned host, and summarizes the recorded memory samples. The
samples are single-run observations, not a leak-freedom or capacity claim.

With --long-session MIN_SECONDS the report must come from the opt-in
wall-clock session mode instead; the totals are recomputed from its recorded
round count and the session checks in native-workspace-session.py apply.
--phases adds the host's BUN_NATIVE_PHASE_TRACE render/paint summary.
"""

import json
import sys
from pathlib import Path

from . import native_workspace_session as SESSION

ROUNDS = 60
SAMPLE_EVERY = 10
PLANS_PER_ROUND = 8
# Per four plans: two complete (8 + 8 timers), one stopped after three steps
# (4 timers) and one switched away after two steps (3 timers).
TIMERS_PER_FOUR_PLANS = 23
RESOURCE_KEYS = {
    "windows",
    "nodes",
    "callbacks",
    "queuedTransactions",
    "queuedCallbacks",
    "activeCallbacks",
    "serviceRequests",
}


def check(report, minimum_seconds=None):
    if minimum_seconds is None:
        if "session" in report:
            raise AssertionError("A long-session report needs --long-session")
        rounds = ROUNDS
    else:
        rounds = SESSION.check_session(report, minimum_seconds, "typedTasks")
    plans = rounds * PLANS_PER_ROUND
    expected = {
        "schemaVersion": 1,
        "status": "passed",
        "scenario": "react-workspace-soak",
        "rounds": rounds,
        "plans": plans,
        "completedPlans": plans // 2,
        "stoppedPlans": plans // 4,
        "switchedPlans": plans // 4,
        "ignoredStaleCallbacks": plans // 4,
        "scheduledTimers": plans // 4 * TIMERS_PER_FOUR_PLANS,
        "cancelledTimers": plans // 2,
    }
    for key, value in expected.items():
        if report.get(key) != value:
            raise AssertionError(f"{key}: expected {value!r}, got {report.get(key)!r}")
    final = report["final"]
    if set(final["application"]) != RESOURCE_KEYS or any(final["application"].values()):
        raise AssertionError(f"Final public resources must be zero: {final}")
    if final["pendingTimers"] != 0:
        raise AssertionError(f"Final local work must be released: {final}")
    # The long-session mode also samples the macOS host (ps and lsof).
    platforms = ("linux",) if minimum_seconds is None else ("linux", "darwin")
    if report["system"]["platform"] not in platforms:
        raise AssertionError(
            f"This check covers the {' and '.join(platforms)} native host"
        )
    durations = report["roundDurationsMs"]
    if len(durations) != rounds or min(durations) <= 0:
        raise AssertionError("Every round must record a positive duration")
    if report["commits"] <= report["actions"] // 2:
        raise AssertionError("Native acknowledgements must cover the driven actions")
    samples = report["samples"]
    marks = [sample["round"] for sample in samples]
    if minimum_seconds is None and marks != list(range(0, ROUNDS + 1, SAMPLE_EVERY)):
        raise AssertionError(f"Unexpected sample rounds: {marks}")
    for sample in samples:
        if not isinstance(sample["hostRssKiB"], int) or sample["hostRssKiB"] <= 0:
            raise AssertionError("Every sample must observe the owned native host RSS")
        if sample["objectCount"] <= 0 or sample["bunRssBytes"] <= 0:
            raise AssertionError("Every sample must record live heap and RSS")
    if minimum_seconds is not None:
        return {"plans": plans, **SESSION.summarize_session(report)}
    first, warm, last = samples[0], samples[1], samples[-1]
    return {
        "rounds": ROUNDS,
        "plans": plans,
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
    arguments = sys.argv[1:]
    minimum_seconds = phases = None
    if len(arguments) in (3, 5) and arguments[1] == "--long-session":
        minimum_seconds = int(arguments[2])
        if len(arguments) == 5:
            if arguments[3] != "--phases":
                arguments = []
            phases = arguments[4] if arguments else None
    elif len(arguments) != 1:
        arguments = []
    if not arguments:
        raise SystemExit(
            "usage: native-react-workspace-soak.py SOAK_RESULT_JSON"
            " [--long-session MIN_SECONDS [--phases PHASE_TRACE_JSON]]"
        )
    report = json.loads(Path(arguments[0]).read_text())
    summary = check(report, minimum_seconds)
    if phases is not None:
        summary["hostFrames"] = SESSION.summarize_phases(phases)
    print(json.dumps(summary, indent=2))
