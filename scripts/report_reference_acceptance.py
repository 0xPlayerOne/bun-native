"""Verify preserved reference evidence and derive descriptive, non-comparative summaries."""

import argparse
import gzip
import hashlib
import json
import math
import re
import statistics
from pathlib import Path

ADAPTERS = ("electron", "electrobun", "mirin", "butter")
STEPS = ("initial-build", "initial-launch", "backend-edit", "failed-edit", "repair")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def statistics_for(values):
    if not values or any(
        type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in values
    ):
        raise ValueError("Invalid observed samples")
    ordered = sorted(values)

    def quantile(p):
        position = (len(ordered) - 1) * p
        low = math.floor(position)
        high = min(low + 1, len(ordered) - 1)
        return ordered[low] + (ordered[high] - ordered[low]) * (position - low)

    return {
        "count": len(values),
        "mean": statistics.mean(values),
        "p50": quantile(0.5),
        "p95": quantile(0.95),
        "p99": quantile(0.99),
        "min": min(values),
        "max": max(values),
        "standardDeviation": statistics.stdev(values) if len(values) > 1 else None,
        "method": "linear-interpolated descriptive quantiles; not independent per-event confidence intervals",
    }


def verify_matrix(matrix):
    plan, trials = matrix["plan"], matrix["trials"]
    if tuple(plan["adapters"]) != ADAPTERS or plan["repetitions"] != 3 or plan["warmups"] != 1:
        raise ValueError("Unexpected preserved reference plan")
    expected = {(a, w, n) for a in ADAPTERS for w in (True, False) for n in range(1 if w else 3)}
    seen = set()
    for t in trials:
        key = (t["adapter"], t["warmup"], t["trial"])
        if key in seen or key not in expected or t.get("failed") is not None:
            raise ValueError("Failed, duplicate, or undeclared reference trial")
        seen.add(key)
        result = t["result"]["result"]
        if not t["result"]["passed"] or not result["passed"] or result["cleanupFailures"]:
            raise ValueError("Reference application did not pass")
        if tuple(s["name"] for s in result["steps"]) != STEPS or any(
            s["status"] != "passed" for s in result["steps"]
        ):
            raise ValueError("Incomplete desktop step matrix")
        idle = t["idle"]
        if (
            not idle["observed"]
            or idle["sampleCount"] < 20
            or idle["sampledDurationMs"] < 4500
            or idle["kernel"]["status"] != "observed"
        ):
            raise ValueError("Incomplete native idle measurements")
    if seen != expected or not matrix["passed"]:
        raise ValueError("Incomplete reference matrix")
    source, after = matrix["source"], matrix["sourceAfter"]
    if not source["clean"] or not after["clean"] or source["commit"] != after["commit"]:
        raise ValueError("Measured source was not stable and committed")


def summarize_matrix(matrix):
    verify_matrix(matrix)
    result = []
    conditions = []
    for name in ADAPTERS:
        rows = [t for t in matrix["trials"] if t["adapter"] == name and not t["warmup"]]
        identities = []
        for t in rows:
            application = t["result"]
            host = application["result"]["steps"][1]["observations"][0]["host"]
            if name == "butter":
                engine, version = "system-webkit", application["systemWebKit"]["bundleVersion"]
            elif name == "electron":
                engine, version = "chromium", host["engineVersion"]
            else:
                engine, version = "chromium", application["engineIdentity"]["chromiumVersion"]
            if not re.fullmatch(r"\d+(?:\.\d+){2,}", version):
                raise ValueError("Unknown actual engine")
            identities.append(
                {
                    "framework": host["framework"],
                    "version": host["frameworkVersion"],
                    "runtimeVersion": host["runtimeVersion"],
                    "engine": engine,
                    "engineVersion": version,
                }
            )
        if any(i != identities[0] for i in identities):
            raise ValueError("Reference identity changed")
        values = {
            "buildMs": [t["result"]["result"]["steps"][0]["elapsedMs"] for t in rows],
            "launchToRendererMs": [
                t["result"]["result"]["steps"][1]["timings"]["launchToRendererMs"] for t in rows
            ],
            "backendEditToUsableMs": [t["result"]["result"]["steps"][2]["elapsedMs"] for t in rows],
            "idleCpuPercentOneCore": [t["idle"]["cpuPercentOneCore"] for t in rows],
            "idleObservedTreeRssBytes": [t["idle"]["peakTreeRssBytes"] for t in rows],
        }
        for metric in ("packageIdleWakeups", "interruptWakeups"):
            values[metric + "PerSecond"] = []
            for t in rows:
                counter = next(
                    c
                    for c in t["idle"]["kernel"]["metrics"]
                    if c["metric"] == metric and c["provider"] == "darwin-proc-rusage-v0"
                )
                values[metric + "PerSecond"].append(
                    counter["observedDelta"] / (counter["sampledDurationMs"] / 1000)
                )
        installed = [
            next(b for b in t["result"]["bytes"] if b["category"] == "installed")["bytes"]
            for t in rows
        ]
        condition_rows = [
            t[k] for t in matrix["trials"] if t["adapter"] == name for k in ("before", "after")
        ]
        conditions.extend(condition_rows)
        result.append(
            {
                "adapter": name,
                "identity": identities[0],
                "measuredTrials": len(rows),
                "warmups": 1,
                "metrics": {k: statistics_for(v) for k, v in values.items()},
                "installedFileBytes": None
                if all(v is None for v in installed)
                else statistics_for(installed),
                "systemBusyPercent": [c["systemBusyPercent"] for c in condition_rows],
                "memoryBoundary": "Observed descendants only; WKWebView launchd/XPC services excluded"
                if name == "butter"
                else "Observed descendant RSS sum, shared pages may be counted twice",
                "buildBoundary": "Main TypeScript bundle, not complete Electron assembly"
                if name == "electron"
                else "Actual upstream application build",
            }
        )
    quiet = all(
        c["power"] == "ac" and c["systemBusyPercent"] <= 10 and c["conditionsMet"]
        for c in conditions
    )
    return {
        "schema": 1,
        "executionSourceCommit": matrix["source"]["commit"],
        "configuredAcceptancePassed": True,
        "prePostConditionsPassed": quiet,
        "controlledPerformanceEligible": False,
        "equivalentEngineComparisonEligible": False,
        "references": result,
        "reason": "Different engine/security cohorts; pre/post samples do not establish controlled isolation; thresholds are not recalibrated",
    }


def load_evidence(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    reports = {}
    for item in manifest["reports"]:
        if not re.fullmatch(r"[a-z0-9-]+\.json\.gz", item["file"]) or item["name"] in reports:
            raise ValueError("Unsafe or duplicate evidence member")
        file = directory / item["file"]
        raw = file.read_bytes()
        if sha(raw) != item["storedSha256"]:
            raise ValueError("Compressed evidence changed")
        with gzip.open(file, "rb") as data:
            expanded = data.read(128 * 1024 * 1024 + 1)
        if len(expanded) > 128 * 1024 * 1024 or sha(expanded) != item["redactedSha256"]:
            raise ValueError("Evidence exceeds limit or changed")
        reports[item["name"]] = json.loads(expanded)
    return manifest, reports


def report(directory):
    manifest, values = load_evidence(directory)
    matrix = summarize_matrix(values["matrix"])
    if matrix["executionSourceCommit"] != manifest["executionSourceCommit"]:
        raise ValueError("Evidence source mismatch")
    installed = []
    for index in range(4):
        value, owner = values[f"installed-{index}"], values[f"installed-{index}-supervisor"]
        if (
            not value["passed"]
            or not value["sourceClean"]
            or value["sourceCommit"] != manifest["executionSourceCommit"]
            or owner["exitCode"]
            or owner["observedOrphans"]
            or owner["cleanupSurvivors"]
            or owner["timedOut"]
        ):
            raise ValueError("Installed transaction or owner cleanup failed")
        if index:
            installed.append(value)
    latency = values["latency"]
    if (
        not latency["passed"]
        or len(latency["trials"]) != 4
        or any(not t["passed"] for t in latency["trials"])
    ):
        raise ValueError("Incomplete latency qualification")
    latency_trials = [
        {
            "trial": t["trial"],
            "inputHandlerToFrameMs": statistics_for(
                [e["handlerToFrame"] for e in t["measurements"]["input"]]
            ),
            "inputEventToFrameMs": statistics_for(
                [e["eventToFrame"] for e in t["measurements"]["input"]]
            ),
            "terminalParserCallbackMs": statistics_for(
                [e["callbackMs"] for e in t["measurements"]["writes"]]
            ),
        }
        for t in latency["trials"]
        if not t["warmup"]
    ]
    return {
        "matrix": matrix,
        "installed": {
            "warmups": 1,
            "repetitions": 3,
            "firstRunMs": statistics_for(
                [
                    next(s["elapsedMs"] for s in v["steps"] if s["name"] == "installed-first-run")
                    for v in installed
                ]
            ),
            "updateAndRelaunchMs": statistics_for(
                [
                    next(
                        s["elapsedMs"]
                        for s in v["steps"]
                        if s["name"] == "upstream-update-and-relaunch"
                    )
                    for v in installed
                ]
            ),
            "initialDownloadBytes": [v["firstRunTransfer"]["receivedBytes"] for v in installed],
            "updateDownloadBytes": [
                next(e["received"] for e in v["events"] if e["name"] == "download-verified")
                for v in installed
            ],
        },
        "latencyTrials": latency_trials,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", nargs="?", default="evidence/m2-measured")
    args = parser.parse_args()
    print(json.dumps(report(Path(args.directory)), indent=2))
