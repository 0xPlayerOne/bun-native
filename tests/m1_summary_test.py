"""Regression checks for evidence reduction; no native/browser/CI substitute."""

import copy
import hashlib
import json
import sys
import tempfile
import unittest
import warnings
from pathlib import Path
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from kernel_counters import summarize_counters  # noqa: E402
from summarize_m1 import (  # noqa: E402
    FAULTS,
    MODES,
    TARGETS,
    compile_report,
    kernel_summary,
    load_json,
    read_archive,
    resource_summary,
    validate_observation,
)


def sample(at, phase="idle", rss=100, cpu=0.0, birth=1.0):
    row = {"pid": 42, "creationTime": birth, "rssBytes": rss, "threads": 2, "cpuSeconds": cpu}
    return {"elapsedMs": at, "phase": phase, "processes": [row], "rssBytes": rss, "threads": 2}


def observation(mode="ffi", crash=False):
    count = 28 if mode == "process" else 26
    return {
        "schema": 1,
        "exitCode": -6 if crash else 0,
        "timedOut": False,
        "outputOverflow": False,
        "observedOrphans": [],
        "samples": [sample(1, "startup"), sample(5), sample(15, rss=300, cpu=0.001)],
        "reports": []
        if crash
        else [
            {
                "passed": True,
                "mode": mode,
                "generations": count,
                "results": [{"generation": i} for i in range(count)],
            }
        ],
        "environment": {"runClass": "ci-smoke", "os": "ExampleOS", "arch": "x64"},
    }


def add_kernel(report, target):
    for i, item in enumerate(report["samples"]):
        if target == "win32-x64":
            counters = {
                "provider": "windows-etw-not-implemented",
                "status": "unavailable",
                "reason": "No qualified Windows ETW collector",
                "counters": [],
            }
        else:
            counters = {
                "provider": "example-kernel",
                "status": "available",
                "reason": "",
                "counters": [{"name": "wakeups", "scope": "42:1", "value": i}],
            }
        item["processes"][0]["kernelCounters"] = counters
    report["kernelMeasurements"] = summarize_counters(report["samples"])
    return report


def fixtures(directory, mutate=None):
    inputs = {
        "schema": 1,
        "bun": "1.4.4",
        "testedHeadCommit": "head",
        "testedMergeCommit": "merge",
        "nativeProbeCompiler": "1.85.1",
        "artifacts": [],
    }
    for kind in ("kernel", "lifecycle"):
        for target in TARGETS:
            files = {}
            summary = {
                "schema": 1,
                "target": target,
                "bun": "1.4.4",
                "commit": "merge",
                "results": [],
                "passed": True,
            }
            if kind == "kernel":
                for mode in MODES:
                    files[f"kernel-{target}-{mode}.json"] = add_kernel(observation(mode), target)
            else:
                for case in sorted(FAULTS):
                    name = f"lifecycle-{target}-{case}.json"
                    mode = case.split("-")[0]
                    files[name] = observation(mode, case == "native-crash")
                    summary["results"].append(
                        {
                            "name": case,
                            "passed": True,
                            "expectedCrash": case == "native-crash",
                            "report": name,
                        }
                    )
            files[f"{kind}-summary-{target}.json"] = summary
            if mutate:
                mutate(kind, target, files)
            path = directory / f"{kind}-{target}.zip"
            with ZipFile(path, "w") as archive:
                for name, value in files.items():
                    archive.writestr(name, json.dumps(value))
            inputs["artifacts"].append(
                {
                    "kind": kind,
                    "target": target,
                    "file": path.name,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            )
    return inputs


class ObservationTests(unittest.TestCase):
    def test_first_idle_is_not_total_duration_or_generation_average(self):
        result = resource_summary(observation())
        self.assertEqual(result["firstIdleObservedMs"], 5)
        self.assertEqual(result["idleMedianTreeRssBytes"], 200)
        self.assertEqual(result["idleMatchedIntervalMs"], 10)
        self.assertEqual(result["peakConcurrentProcesses"], 1)

    def test_phase_gaps_are_not_counted_as_idle(self):
        report = observation()
        report["samples"] += [sample(100, "work", cpu=2), sample(200, cpu=3)]
        self.assertEqual(resource_summary(report)["idleMatchedIntervalMs"], 10)

    def test_pid_reuse_does_not_charge_previous_process_cpu(self):
        report = observation()
        report["samples"][-1]["processes"][0]["creationTime"] = 2.0
        result = resource_summary(report)
        self.assertEqual(result["idleMatchedIntervalMs"], 0)
        self.assertIsNone(result["idleObservedCpuPercentOfOneCore"])

    def test_unavailable_is_not_a_zero_counter(self):
        value = kernel_summary(add_kernel(observation(), "win32-x64"), "win32-x64")
        self.assertEqual(value["status"], "unavailable")
        self.assertEqual(value["metrics"], [])
        self.assertTrue(value["limitations"])

    def test_unavailable_linux_cannot_qualify_as_observed(self):
        report = add_kernel(observation(), "win32-x64")
        with self.assertRaisesRegex(ValueError, "Required kernel"):
            kernel_summary(report, "linux-x64")

    def test_failed_exit_timeout_overflow_and_orphans_are_never_passes(self):
        for key, value in [
            ("exitCode", 1),
            ("timedOut", True),
            ("outputOverflow", True),
            ("observedOrphans", [7]),
        ]:
            with self.subTest(key=key):
                report = observation()
                report[key] = value
                with self.assertRaises(ValueError):
                    validate_observation(report)

    def test_unexpected_native_success_is_not_a_verified_crash(self):
        with self.assertRaisesRegex(ValueError, "process exit"):
            validate_observation(observation(), expected_crash=True)
        validate_observation(observation(crash=True), expected_crash=True)

    def test_nonmonotonic_and_missing_idle_reject(self):
        report = observation()
        report["samples"][1]["elapsedMs"] = 0
        with self.assertRaisesRegex(ValueError, "Non-monotonic"):
            resource_summary(report)
        report = observation()
        for row in report["samples"]:
            row["phase"] = "startup"
        with self.assertRaisesRegex(ValueError, "No idle"):
            resource_summary(report)

    def test_inconsistent_totals_and_duplicate_identities_reject(self):
        report = observation()
        report["samples"][0]["rssBytes"] += 1
        with self.assertRaisesRegex(ValueError, "RSS total"):
            resource_summary(report)
        report = observation()
        report["samples"][0]["processes"] *= 2
        with self.assertRaisesRegex(ValueError, "Duplicate process"):
            resource_summary(report)

    def test_kernel_delta_recomputed_not_trusted_from_summary(self):
        report = add_kernel(observation(), "linux-x64")
        report["kernelMeasurements"]["metrics"][0]["observedDelta"] += 1
        with self.assertRaisesRegex(ValueError, "does not reproduce"):
            kernel_summary(report, "linux-x64")


class ArchiveTests(unittest.TestCase):
    def test_complete_matrix_is_deterministic_and_keeps_windows_unavailable(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            inputs = fixtures(directory)
            result = compile_report(inputs, directory)
            self.assertEqual(result, compile_report(inputs, directory))
            self.assertEqual(len(result["rows"]), 9)
            self.assertEqual(len(result["faultResults"]), 3)
            windows = [row for row in result["rows"] if row["target"] == "win32-x64"]
            self.assertTrue(all(row["kernel"]["status"] == "unavailable" for row in windows))

    def test_artifact_digest_mismatch_fails_before_parsing(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            inputs = fixtures(directory)
            inputs["artifacts"][0]["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                compile_report(inputs, directory)

    def test_missing_and_duplicate_archive_matrix_reject(self):
        with tempfile.TemporaryDirectory() as root:
            inputs = fixtures(Path(root))
            for subset in [
                inputs["artifacts"][:-1],
                inputs["artifacts"][:-1] + inputs["artifacts"][:1],
            ]:
                value = {**inputs, "artifacts": subset}
                with self.assertRaisesRegex(ValueError, "input matrix"):
                    compile_report(value, Path(root))

    def test_wrong_source_and_runtime_are_not_joined(self):
        with tempfile.TemporaryDirectory() as root:
            inputs = fixtures(Path(root))
            for field in ("testedMergeCommit", "bun"):
                value = {**inputs, field: "different"}
                with self.assertRaises(ValueError):
                    compile_report(value, Path(root))

    def test_generation_omission_cannot_count_as_pass(self):
        def mutate(kind, target, files):
            if kind == "lifecycle":
                files[f"lifecycle-{target}-ffi-normal.json"]["reports"][-1]["results"].pop()

        with tempfile.TemporaryDirectory() as root:
            inputs = fixtures(Path(root), mutate)
            with self.assertRaisesRegex(ValueError, "generation matrix"):
                compile_report(inputs, Path(root))

    def test_different_runner_memory_is_retained_not_called_paired(self):
        def mutate(kind, _target, files):
            for data in files.values():
                if "environment" in data:
                    data["environment"]["memoryBytes"] = 100 if kind == "kernel" else 200

        with tempfile.TemporaryDirectory() as root:
            inputs = fixtures(Path(root), mutate)
            row = compile_report(inputs, Path(root))["rows"][0]
            self.assertEqual(row["environment"]["memoryBytes"], 200)
            self.assertEqual(row["kernelEnvironment"]["memoryBytes"], 100)

    def test_duplicate_and_traversal_members_reject_without_extraction(self):
        for names in [("a.json", "a.json"), ("../a.json",)]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as root:
                path = Path(root) / "input.zip"
                with warnings.catch_warnings(), ZipFile(path, "w") as archive:
                    warnings.simplefilter("ignore", UserWarning)
                    for name in names:
                        archive.writestr(name, "{}")
                spec = {"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                with self.assertRaises(ValueError):
                    read_archive(path.parent, spec)

    def test_json_duplicate_keys_nonfinite_and_false_numeric_reject(self):
        for data in ('{"x": 1, "x": 2}', '{"n":NaN}', '{"n":Infinity}'):
            with self.assertRaises(ValueError):
                load_json(data)
        report = copy.deepcopy(observation())
        report["samples"][0]["elapsedMs"] = True
        with self.assertRaises(ValueError):
            resource_summary(report)


if __name__ == "__main__":
    unittest.main()
