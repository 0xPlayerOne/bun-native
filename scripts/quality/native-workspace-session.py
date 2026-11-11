"""Shared checks and summaries for long workspace soak sessions (#248, #250).

A long session is the fixed soak round run until a wall-clock budget passes
(tests/native/workspace-session.ts). These checks require the budget to have
been met, a sample at least every interval (plus one round), every sample to
observe both processes, and the X11 input counts to match the rounds. The
summary describes the recorded samples; it is not a leak-freedom proof.
"""

import itertools
import json

PROCESS_KEYS = ("rssKiB", "hwmKiB", "threads", "fds", "cpuTicks")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def check_session(report, minimum_seconds, input_key):
    """Validate the long-session part of a soak report; return its round count."""
    session = report.get("session")
    require(isinstance(session, dict), "A long-session report needs its session record")
    require(
        session["seconds"] >= minimum_seconds,
        f"Session budget {session['seconds']} s is below {minimum_seconds} s",
    )
    rounds = report["rounds"]
    require(isinstance(rounds, int) and rounds >= 1, "A session needs whole rounds")
    require(
        report["elapsedMs"] >= session["seconds"] * 1000,
        "The session ended before its wall-clock budget",
    )
    durations = report["roundDurationsMs"]
    require(
        len(durations) == rounds and min(durations) > 0,
        "Every round must record a positive duration",
    )
    samples = report["samples"]
    require(len(samples) >= 2, "A session needs its baseline and final samples")
    marks = [sample["round"] for sample in samples]
    require(marks[0] == 0 and marks[-1] == rounds, f"Unexpected sample rounds {marks}")
    require(marks == sorted(set(marks)), "Sample rounds must increase")
    elapsed = [sample["elapsedMs"] for sample in samples]
    # A sample is due at the first round boundary after each interval.
    allowed = session["sampleSeconds"] * 1000 + max(durations) + 1000
    for before, after in itertools.pairwise(elapsed):
        require(0 < after - before <= allowed, "A sample interval was missed")
    for sample in samples:
        for name in ("host", "app"):
            observed = sample.get(name)
            require(
                isinstance(observed, dict)
                and all(
                    isinstance(observed.get(key), int) and observed[key] > 0
                    for key in PROCESS_KEYS
                    if key != "cpuTicks"
                ),
                f"Every sample must observe the {name} process",
            )
        require(sample["hostRssKiB"] == sample["host"]["rssKiB"], "Host RSS mismatch")
        require(
            sample["objectCount"] > 0 and sample["bunRssBytes"] > 0,
            "Every sample must record live heap and RSS",
        )
    require(session["ackMs"]["count"] > 0, "No native acknowledgements were timed")
    if session["osInput"] is not None:
        typed = session["osInput"]
        require(
            session["osInput"] and typed[input_key] == rounds,
            "One typed entry per round",
        )
        require(typed["keys"] == rounds, "One Return per round")
        require(
            typed["wheelNotches"] == rounds * 24, "Twenty-four wheel notches per round"
        )
        require(
            session["inputToStateMs"]["count"] == rounds * 2,
            "Each typed entry times its text and its submission",
        )
    return rounds


def slope_per_hour(samples, value):
    """Least-squares slope of value(sample) per hour of elapsed time."""
    points = [(sample["elapsedMs"] / 3_600_000, value(sample)) for sample in samples]
    if len(points) < 2:
        return None
    mean_x = sum(x for x, _ in points) / len(points)
    mean_y = sum(y for _, y in points) / len(points)
    spread = sum((x - mean_x) ** 2 for x, _ in points)
    if spread == 0:
        return None
    return round(
        sum((x - mean_x) * (y - mean_y) for x, y in points) / spread,
        3,
    )


def summarize_session(report):
    samples = report["samples"]
    # The first tenth of the session is warm-up (JIT, allocator and font caches).
    settled_after = report["elapsedMs"] * 0.1
    settled = [sample for sample in samples if sample["elapsedMs"] >= settled_after]
    series = {
        "hostRssKiB": lambda sample: sample["host"]["rssKiB"],
        "appRssKiB": lambda sample: sample["app"]["rssKiB"],
        "heapSize": lambda sample: sample["heapSize"],
        "objectCount": lambda sample: sample["objectCount"],
        "hostFds": lambda sample: sample["host"]["fds"],
        "appFds": lambda sample: sample["app"]["fds"],
        "hostThreads": lambda sample: sample["host"]["threads"],
        "appThreads": lambda sample: sample["app"]["threads"],
    }
    summary = {}
    for name, value in series.items():
        values = [value(sample) for sample in samples]
        summary[name] = {
            "first": values[0],
            "settledFirst": value(settled[0]),
            "last": values[-1],
            "min": min(values),
            "max": max(values),
            "settledSlopePerHour": slope_per_hour(settled, value),
        }
    loads = [sample["loadAverage"][0] for sample in samples]
    session = report["session"]
    return {
        "seconds": session["seconds"],
        "paceMs": session["paceMs"],
        "elapsedMs": round(report["elapsedMs"]),
        "rounds": report["rounds"],
        "actions": report["actions"],
        "commits": report["commits"],
        "samples": len(samples),
        "roundMs": {
            "median": round(
                sorted(report["roundDurationsMs"])[report["rounds"] // 2], 2
            ),
            "max": round(max(report["roundDurationsMs"]), 2),
        },
        "ackMs": session["ackMs"],
        "inputToStateMs": session["inputToStateMs"],
        "osInput": session["osInput"],
        "series": summary,
        "loadAverage1m": {"min": min(loads), "max": max(loads)},
    }


def summarize_phases(path):
    """Host render/paint durations from a BUN_NATIVE_PHASE_TRACE record."""
    with open(path) as stream:
        trace = json.load(stream)
    require(trace.get("schemaVersion") == 1, "Unknown phase trace schema")
    columns = trace["frameColumns"]
    started = columns.index("startedNanos")
    render = columns.index("renderNanos")
    paint = columns.index("renderToPaintNanos")
    frames = trace["frames"]

    def distribution(values):
        if not values:
            return {"count": 0}
        values = sorted(values)

        def pick(q):
            return round(values[min(len(values) - 1, int(q * len(values)))] / 1e6, 3)

        return {
            "count": len(values),
            "p50": pick(0.5),
            "p95": pick(0.95),
            "p99": pick(0.99),
            "max": round(values[-1] / 1e6, 3),
        }

    return {
        "renders": trace["renders"],
        "recordedFrames": len(frames),
        "droppedFrames": trace["droppedFrames"],
        "coveredSeconds": round(frames[-1][started] / 1e9, 1) if frames else 0,
        "renderMs": distribution([frame[render] for frame in frames]),
        "renderToPaintMs": distribution(
            [frame[paint] for frame in frames if frame[paint] is not None]
        ),
    }
