"""Summarize retained `tests/native/cli-watch.py` result files for comparison.

Reads the `result.json` of one passed invocation per framework and prints one
JSON document of edit-to-usable observation statistics, CLI-reported phase
durations and sampled controller/process-tree RSS. It never runs the app. The
numbers are observation intervals with diagnostic overhead, not presentation
latency, and two runs on different runners are not a controlled comparison.
"""

import json
import math
import statistics
import sys
from pathlib import Path

CONTROLLER = "cli-controller"


def percentile(values, fraction):
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = math.floor(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def stats(values):
    if not values:
        raise ValueError("No observations to summarize")
    return {
        "count": len(values),
        "median": round(statistics.median(values), 3),
        "p95": round(percentile(values, 0.95), 3),
        "maximum": round(max(values), 3),
    }


def summarize(result):
    if result.get("status") != "passed":
        raise ValueError("Only a passed watch result can be summarized")
    generations = result["generations"]
    edits = generations[1:]
    if len(edits) != result["planned_source_edits"]:
        raise ValueError("Result does not retain every planned source edit")
    controller = [
        sum(
            item["rss_bytes"]
            for item in row["process_snapshot"]["processes"]
            if item["role"] == CONTROLLER
        )
        for row in generations
    ]
    tree = [row["process_snapshot"]["tree_rss_bytes"] for row in generations]
    values = [row["ready"]["value"] for row in edits]
    bun = result["toolchain"]["bun"]
    return {
        "framework": result["framework"],
        "bun": bun["cliRevision"],
        "generations": len(generations),
        "cliEditToReadyMs": stats([value["editToReadyMs"] for value in values]),
        "cliBundleMs": stats([value["bundleMs"] for value in values]),
        "cliShutdownMs": stats([value["shutdownMs"] for value in values]),
        "cliMountMs": stats([value["mountMs"] for value in values]),
        "observedEditToReadyMs": stats(
            [row["trigger_to_ready_record_observed_ms"] for row in edits]
        ),
        "observedEditToFirstPaintMs": stats(
            [row["trigger_to_initial_paint_observed_ms"] for row in edits]
        ),
        "observedEditToInputConfirmedPaintMs": stats(
            [row["trigger_to_input_confirmed_paint_observed_ms"] for row in edits]
        ),
        "controllerRssBytes": {
            "first": controller[0],
            "last": controller[-1],
            "maximum": max(controller),
        },
        "treeRssBytes": {
            "first": tree[0],
            "last": tree[-1],
            "maximum": max(tree),
        },
        "maximumLiveNativeHosts": result["process_audit"]["maximum_live_native_hosts"],
        "maximumLiveApplicationProcesses": result["process_audit"][
            "maximum_live_application_processes"
        ],
    }


def main(argv):
    if len(argv) < 2:
        raise SystemExit("usage: watch-run-summary.py RESULT.json [RESULT.json ...]")
    print(
        json.dumps(
            [summarize(json.loads(Path(path).read_text())) for path in argv[1:]],
            indent=2,
        )
    )


if __name__ == "__main__":
    main(sys.argv)
