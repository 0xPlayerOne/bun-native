"""Reproduce M1's decision inputs from six hash-pinned, completed CI artifacts.

This is an offline evidence reducer, not a benchmark runner or a CI bypass.
Kernel and lifecycle runs stay separate; unavailable counters never become zeros.
"""

import argparse
import hashlib
import json
import math
import statistics
from pathlib import Path
from zipfile import ZipFile

from kernel_counters import summarize_counters

TARGETS = ("linux-x64", "darwin-arm64", "win32-x64")
MODES = ("ffi", "napi", "process")
FAULTS = {"ffi-normal", "ffi-hang", "napi-normal", "napi-hang", "process-soak", "native-crash"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def load_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("Non-finite JSON value")

    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid_constant)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def read_archive(directory, spec):
    filename = spec["file"]
    require(Path(filename).name == filename, "Archive must be a local basename")
    path = directory / filename
    require(digest(path) == spec["sha256"], "Artifact digest mismatch: " + filename)
    records, hashes = {}, {}
    with ZipFile(path) as archive:
        members = archive.infolist()
        require(len(members) <= 64, "Too many artifact members")
        require(
            sum(item.file_size for item in members) <= 64 * 1024 * 1024,
            "Artifact expanded-size limit",
        )
        for item in members:
            name = item.filename
            require(
                Path(name).name == name and name.endswith(".json"), "Unexpected artifact member"
            )
            require(name not in records, "Duplicate artifact member")
            require(item.file_size <= 16 * 1024 * 1024, "Artifact member-size limit")
            data = archive.read(item)
            records[name] = load_json(data)
            hashes[name] = hashlib.sha256(data).hexdigest()
    return records, hashes


def validate_observation(report, expected_crash=False):
    require(report.get("schema") == 1, "Observation schema mismatch")
    require(report.get("timedOut") is False, "Observation timed out")
    require(report.get("outputOverflow") is False, "Observation output overflow")
    require(report.get("observedOrphans") == [], "Observed orphan descendants")
    code = report.get("exitCode")
    require(
        type(code) is int and (code != 0 if expected_crash else code == 0),
        "Unexpected process exit",
    )
    if not expected_crash:
        require(
            report.get("reports") and report["reports"][-1].get("passed") is True,
            "Missing successful application assertions",
        )
    samples = report.get("samples")
    require(isinstance(samples, list) and 0 < len(samples) <= 4000, "Missing or excessive samples")
    previous = -1
    for sample in samples:
        current = sample.get("elapsedMs")
        require(number(current) and current > previous, "Non-monotonic samples")
        previous = current
        require(sample.get("phase") in ("startup", "idle", "work"), "Unknown phase")
        rows = sample.get("processes")
        require(isinstance(rows, list) and len(rows) <= 4096, "Invalid process rows")
        identities = set()
        for row in rows:
            identity = (row.get("pid"), row.get("creationTime"))
            require(
                type(identity[0]) is int and identity[0] > 0 and number(identity[1]),
                "Invalid process identity",
            )
            require(identity not in identities, "Duplicate process identity")
            identities.add(identity)
            require(
                all(type(row.get(key)) is int and row[key] >= 0 for key in ("rssBytes", "threads")),
                "Invalid resource count",
            )
            require(number(row.get("cpuSeconds")), "Invalid CPU time")
        require(
            sample.get("rssBytes") == sum(row["rssBytes"] for row in rows),
            "RSS total differs from process rows",
        )
        require(
            sample.get("threads") == sum(row["threads"] for row in rows),
            "Thread total differs from process rows",
        )
    return samples


def resource_summary(report):
    samples = validate_observation(report)
    idle = [sample for sample in samples if sample["phase"] == "idle" and sample["processes"]]
    require(idle, "No idle observations")
    cpu, duration = 0.0, 0.0
    for before, after in zip(samples, samples[1:], strict=False):
        if before["phase"] != "idle" or after["phase"] != "idle":
            continue
        old = {(row["pid"], row["creationTime"]): row for row in before["processes"]}
        matched = False
        for row in after["processes"]:
            prior = old.get((row["pid"], row["creationTime"]))
            if prior is None or row["cpuSeconds"] < prior["cpuSeconds"]:
                continue
            cpu += row["cpuSeconds"] - prior["cpuSeconds"]
            matched = True
        if matched:
            duration += after["elapsedMs"] - before["elapsedMs"]
    return {
        "samples": len(samples),
        "idleSamples": len(idle),
        "firstIdleObservedMs": idle[0]["elapsedMs"],
        "idleMedianTreeRssBytes": statistics.median(s["rssBytes"] for s in idle),
        "idlePeakTreeThreads": max(s["threads"] for s in idle),
        "peakConcurrentProcesses": max(len(s["processes"]) for s in samples),
        "peakTreeRssBytes": max(s["rssBytes"] for s in samples),
        "idleMatchedIntervalMs": duration,
        "idleObservedCpuPercentOfOneCore": cpu * 100000 / duration if duration else None,
    }


def kernel_summary(report, target):
    samples = validate_observation(report)
    calculated = summarize_counters(samples)
    require(
        calculated == report.get("kernelMeasurements"), "Archived kernel summary does not reproduce"
    )
    if target == "win32-x64":
        require(
            calculated["status"] == "unavailable" and not calculated["metrics"],
            "Unexpected Windows counter evidence; review support decision",
        )
    else:
        require(calculated["status"] == "observed", "Required kernel evidence missing")
        require(
            any(
                row["phase"] == "idle" and row["sampledDurationMs"] > 0
                for row in calculated["metrics"]
            ),
            "No measured idle intervals",
        )
    return calculated


def compile_report(inputs, directory):
    require(inputs.get("schema") == 1, "Input schema mismatch")
    specifications = inputs["artifacts"]
    keys = [(item["kind"], item["target"]) for item in specifications]
    expected = {(kind, target) for kind in ("kernel", "lifecycle") for target in TARGETS}
    require(len(keys) == len(expected) and set(keys) == expected, "Incomplete input matrix")
    archives, sources = {}, []
    for spec in specifications:
        records, hashes = read_archive(directory, spec)
        summary_name = f"{spec['kind']}-summary-{spec['target']}.json"
        summary = records[summary_name]
        require(
            summary["target"] == spec["target"] and summary["bun"] == inputs["bun"],
            "Runtime or target mismatch",
        )
        require(
            summary.get("sourceCommit", summary.get("commit")) == inputs["testedMergeCommit"],
            "Measured source mismatch",
        )
        archives[(spec["kind"], spec["target"])] = records
        sources.append({**spec, "memberSha256": hashes})
    rows, fault_results = [], []
    for target in TARGETS:
        life, kernel = archives[("lifecycle", target)], archives[("kernel", target)]
        summary = life[f"lifecycle-summary-{target}.json"]
        results = summary["results"]
        require(
            summary["passed"] is True
            and len(results) == len(FAULTS)
            and {row["name"] for row in results} == FAULTS,
            "Incomplete fault matrix",
        )
        for row in results:
            crash = row["name"] == "native-crash"
            require(
                row["passed"] is True and row["expectedCrash"] is crash, "Incorrect fault outcome"
            )
            validate_observation(life[row["report"]], crash)
        fault_results.append(
            {"target": target, "passed": True, "cases": [row["name"] for row in results]}
        )
        for mode in MODES:
            suffix = "process-soak" if mode == "process" else mode + "-normal"
            raw = life[f"lifecycle-{target}-{suffix}.json"]
            observed_kernel = kernel[f"kernel-{target}-{mode}.json"]
            terminal = raw["reports"][-1]
            generations = 28 if mode == "process" else 26
            require(
                terminal.get("mode") == mode
                and terminal["generations"] == generations
                and len(terminal["results"]) == generations,
                "Incomplete generation matrix",
            )
            require(
                [row["generation"] for row in terminal["results"]] == list(range(generations)),
                "Generation ordering mismatch",
            )
            require(
                raw["environment"]["runClass"] == "ci-smoke"
                and observed_kernel["environment"]["runClass"] == "ci-smoke"
                and all(
                    raw["environment"][key] == observed_kernel["environment"][key]
                    for key in ("os", "arch")
                ),
                "Platform mismatch or unsupported performance class",
            )
            rows.append(
                {
                    "target": target,
                    "mode": mode,
                    "generations": generations,
                    "environment": raw["environment"],
                    "kernelEnvironment": observed_kernel["environment"],
                    "resources": resource_summary(raw),
                    "kernel": kernel_summary(observed_kernel, target),
                }
            )
    return {
        "schema": 1,
        "scope": "M1 host feasibility; not desktop performance",
        "testedHeadCommit": inputs["testedHeadCommit"],
        "testedMergeCommit": inputs["testedMergeCommit"],
        "bun": inputs["bun"],
        "nativeProbeCompiler": inputs["nativeProbeCompiler"],
        "sources": sources,
        "faultResults": fault_results,
        "rows": rows,
        "accounting": {
            "startup": "First externally observed idle marker; sampled upper bound, not exact readiness or first GUI frame.",
            "resources": "Uninstrumented lifecycle runs; sum of sampled resident sets can double-count shared pages.",
            "cpu": "Adjacent same-phase, same-process-identity intervals only; excludes unobserved child lifetimes.",
            "kernel": "Separate instrumented runs on different runners; provider-specific matched-interval lower bounds, not energy or battery life.",
            "independence": "One run per mode/target; generations are not independent trials. No causal ranking or confidence interval.",
            "windows": "Wakeup measurement unsupported for M1; no substitute counter, zero, or power claim. See ADR 0002.",
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, default=Path("evidence/m1-host-inputs.json"))
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("evidence/m1-host-results.json"))
    parser.add_argument(
        "--check", action="store_true", help="Compare without modifying committed evidence"
    )
    args = parser.parse_args()
    result = compile_report(load_json(args.inputs.read_bytes()), args.artifacts)
    text = json.dumps(result, indent=2, allow_nan=False) + "\n"
    if args.check:
        require(args.output.read_text() == text, "Committed report differs from verified inputs")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print("Verified 6 archives, 9 host rows, 18 lifecycle/fault cases; no performance ranking.")


if __name__ == "__main__":
    main()
