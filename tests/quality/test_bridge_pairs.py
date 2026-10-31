"""Metadata, trial design and real process guards; these tests do not render GPUI."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "benchmarks/bridge-pairs.py"
SPEC = importlib.util.spec_from_file_location("bridge_pairs", SCRIPT)
PAIRS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAIRS)


class PlanTests(unittest.TestCase):
    def test_equal_warmups_and_five_alternating_pairs_per_mode(self):
        plan = PAIRS.plan_trials(5, 1)
        self.assertEqual(len(plan), 24)
        self.assertEqual(len({row["id"] for row in plan}), 24)
        self.assertEqual([row["stage"] for row in plan[:4]], ["warmup"] * 4)
        for mode in PAIRS.MODES:
            for stage, expected in [("warmup", 1), ("measured", 5)]:
                for variant in PAIRS.VARIANTS:
                    self.assertEqual(
                        sum(
                            row["stage"] == stage
                            and row["mode"] == mode
                            and row["variant"] == variant
                            for row in plan
                        ),
                        expected,
                    )
            for pair in range(1, 6):
                order = [
                    row["variant"]
                    for row in plan
                    if row["stage"] == "measured"
                    and row["mode"] == mode
                    and row["pair"] == pair
                ]
                self.assertEqual(
                    order, ["bn1", "events"] if pair % 2 else ["events", "bn1"]
                )

    def test_insufficient_pairs_and_unequal_or_unbounded_plan_are_rejected(self):
        for pairs, warmups in [(4, 1), (11, 1), (5, 0), (5, 3), (True, 1)]:
            with (
                self.subTest(pairs=pairs, warmups=warmups),
                self.assertRaises(ValueError),
            ):
                PAIRS.plan_trials(pairs, warmups)

    def test_percentiles_recompute_from_all_samples_and_reject_tampering(self):
        record = {
            "samplesMs": [1, 2, 3, 4, 11, 12, 13, 14, 15, 16],
            "count": 10,
            "p50Ms": 11,
            "p95Ms": 16,
            "p99Ms": 16,
            "totalMs": 91,
        }
        result = PAIRS.sample_distribution(record, 10)
        self.assertEqual(result["over10Ms"], 6)
        for key, value in [
            ("totalMs", 90),
            ("p95Ms", 15),
            ("samplesMs", [1] * 9),
            ("samplesMs", [True] * 10),
            ("samplesMs", [float("inf")] * 10),
        ]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                PAIRS.sample_distribution({**record, key: value}, 10)

    def test_failed_half_pair_never_becomes_an_unpaired_comparison(self):
        metrics = {
            "individual": {
                "p50Ms": 1,
                "p95Ms": 2,
                "p99Ms": 3,
                "totalMs": 1000,
                "over10Ms": 0,
            },
            "batchesOf100": {"p50Ms": 2, "p95Ms": 3, "p99Ms": 4, "totalMs": 20},
        }
        trials = [
            {
                "stage": "measured",
                "pair": pair,
                "mode": "aot",
                "variant": name,
                "status": "passed",
                "metrics": deepcopy(metrics),
            }
            for pair in (1, 2)
            for name in PAIRS.VARIANTS
        ]
        trials[1]["metrics"]["individual"]["p95Ms"] = 4
        trials[3]["status"] = "failed"
        summary = PAIRS.paired_summary(trials)["aot"]
        self.assertEqual(summary["complete_pairs"], 1)
        self.assertEqual(
            summary["comparisons"]["individual.p95Ms"]["median_paired_ratio"], 2
        )
        self.assertIsNone(
            summary["comparisons"]["individual.over10Ms"]["median_paired_ratio"]
        )


class MetadataTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repository = self.root / "source"
        self.repository.mkdir()
        self.package = self.root / "package"
        self.package.mkdir()
        self.host = self.root / "external-host"
        for relative in PAIRS.BASELINE.expected_sources(self.repository) | {
            "benchmarks/bridge.ts"
        }:
            path = self.repository / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("inert metadata fixture; never executed\n")
        self.pins = {"bun": {"revision": "fixture", "cliRevision": "fixture"}}
        (self.repository / "toolchain.json").write_text(json.dumps(self.pins))
        for path in (self.host, self.package / "bridge"):
            path.write_text("inert artifact; never executed\n")
            path.chmod(0o500)
        self.manifest = {
            "schemaVersion": 1,
            "entrypoint": "benchmarks/bridge.ts",
            "verification": {"aotCompiledProgram": "passed", "jitOmission": "passed"},
            "toolchain": self.pins,
            "target": {
                "os": "linux",
                "architecture": {"x86_64": "x64", "aarch64": "arm64"}.get(
                    platform.machine()
                ),
            },
            "application": {
                "file": "bridge",
                **PAIRS.BASELINE.fingerprint(self.package / "bridge"),
                "inspection": {"hasCompiledProgram": True},
                "runtimeFeatures": {
                    "jit": "unused",
                    "removedRangeCount": 27,
                    "jitRemovedRanges": {"count": 27},
                },
            },
            "host": {
                "file": str(self.host),
                "placement": "external",
                "profile": "release",
                **PAIRS.BASELINE.fingerprint(self.host),
            },
            "source": {
                "commit": PAIRS.VARIANTS["bn1"]["commit"],
                "dirty": False,
                "files": [
                    {"path": path, **PAIRS.BASELINE.fingerprint(self.repository / path)}
                    for path in sorted(
                        PAIRS.BASELINE.expected_sources(self.repository)
                        | {"benchmarks/bridge.ts"}
                    )
                ],
            },
        }
        self.save()

    def save(self):
        (self.package / "manifest.json").write_text(json.dumps(self.manifest))

    def verify(self):
        return PAIRS.BASELINE.verify_package(
            self.package, self.repository, entry="bridge", external_host=self.host
        )

    def test_external_bridge_metadata_has_a_valid_distinct_path(self):
        self.assertEqual(self.verify()["entrypoint"], "benchmarks/bridge.ts")

    def test_wrong_host_cannot_inherit_another_artifacts_inspection(self):
        other = self.root / "other-host"
        other.write_text("different artifact")
        with self.assertRaisesRegex(ValueError, "explicitly supplied external host"):
            PAIRS.BASELINE.verify_package(
                self.package, self.repository, entry="bridge", external_host=other
            )

    def test_mutated_host_and_bridge_source_are_both_rejected(self):
        self.host.chmod(0o700)
        self.host.write_text("mutated native implementation")
        with self.assertRaisesRegex(ValueError, "inspected build manifest"):
            self.verify()
        self.manifest["host"].update(PAIRS.BASELINE.fingerprint(self.host))
        self.save()
        (self.repository / "benchmarks/bridge.ts").write_text("different workload")
        with self.assertRaisesRegex(ValueError, "Source differs"):
            self.verify()

    def test_debug_profile_and_wrong_entry_cannot_qualify(self):
        self.manifest["host"]["profile"] = "dev"
        self.save()
        with self.assertRaisesRegex(ValueError, "release-profile"):
            self.verify()
        self.manifest["host"]["profile"] = "release"
        self.manifest["entrypoint"] = "examples/native-window/main.ts"
        self.save()
        with self.assertRaisesRegex(ValueError, "compiled bridge"):
            self.verify()

    def test_jit_retention_and_missing_ranges_cannot_qualify_as_aot(self):
        for replacement in [
            {"jit": "present"},
            {"removedRangeCount": 0},
            {"jitRemovedRanges": {"count": False}},
        ]:
            with self.subTest(replacement=replacement):
                original = deepcopy(self.manifest["application"]["runtimeFeatures"])
                self.manifest["application"]["runtimeFeatures"].update(replacement)
                self.save()
                with self.assertRaisesRegex(ValueError, "JIT removal ranges"):
                    self.verify()
                self.manifest["application"]["runtimeFeatures"] = original

    def test_non_finite_exponents_and_oversized_metadata_fail_closed(self):
        path = self.root / "data.json"
        for text in ('{"x":1e999}', '{"x":NaN}', " " * (PAIRS.MAX_JSON_BYTES + 1)):
            path.write_text(text)
            with self.assertRaises(ValueError):
                PAIRS.read_json(path)
        path.write_text('{"x":1e308}')
        self.assertEqual(PAIRS.read_json(path), {"x": 1e308})

    def test_wrong_historical_commit_rejected_without_native_execution(self):
        with self.assertRaisesRegex(ValueError, "exact recorded merge"):
            PAIRS.source_identity(SCRIPT.parents[1], "bn1")

    def test_a_result_cannot_masquerade_as_another_mode_or_omit_event_drain(self):
        files = self.manifest["source"]["files"]
        artifact = {"bytes": 123, "sha256": "inert-result-fixture"}
        variant = {"application": artifact, "host": artifact, "manifest": artifact}
        build = {"variants": {"events": variant}, "bun": artifact}
        trial = {"variant": "events", "mode": "aot"}

        def samples(count):
            return {
                "samplesMs": [1] * count,
                "count": count,
                "p50Ms": 1,
                "p95Ms": 1,
                "p99Ms": 1,
                "totalMs": count,
            }

        result = {
            "status": "passed",
            "nativeExitCode": 0,
            "protocol": 4,
            "semanticChecks": PAIRS.SEMANTICS,
            "nativeEventCount": 2003,
            "source": {
                "commit": PAIRS.VARIANTS["events"]["commit"],
                "dirty": False,
                "files": files,
            },
            "toolchain": self.pins,
            "target": self.manifest["target"],
            "execution": {
                "mode": "aot",
                "readonlyBuiltin": True,
                "bunRevision": "fixture",
                "application": artifact,
                "aotEvidence": {"manifest": artifact},
            },
            "nativeHost": {"profile": "release", **artifact},
            "methodology": {
                "instrumentation": False,
                "warmupRequests": 20,
                "textNodes": 1000,
                "nativeInputEntityLifecycles": 1000,
            },
            "individual": samples(1000),
            "batchesOf100": samples(10),
        }
        self.assertEqual(
            PAIRS.verify_result(result, trial, build, self.manifest)["individual"][
                "count"
            ],
            1000,
        )
        cases = [
            ("protocol", 2),
            ("nativeEventCount", False),
            ("semanticChecks", PAIRS.SEMANTICS[:-1]),
            ("execution", {**result["execution"], "readonlyBuiltin": False}),
            ("methodology", {**result["methodology"], "instrumentation": True}),
            ("source", {**result["source"], "dirty": True}),
        ]
        for key, value in cases:
            with self.subTest(key=key), self.assertRaises(ValueError):
                PAIRS.verify_result({**result, key: value}, trial, build, self.manifest)


@unittest.skipUnless(
    sys.platform == "linux" and PAIRS.DRIVER.proc_identity_matches(),
    "Linux process IDs and /proc must share a PID namespace",
)
class ProcessTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name)
        PAIRS.DRIVER.enable_subreaper()

    def test_identity_verified_child_exits_normally_without_forced_cleanup(self):
        outcome = PAIRS.run_owned(
            [
                sys.executable,
                "-c",
                "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(.4)']); p.wait(); print('joined')",
            ],
            self.output,
            self.output / "normal",
            3,
            expected_host=Path(sys.executable).resolve(),
        )
        self.assertEqual(outcome["status"], "passed", outcome)
        self.assertEqual(len(outcome["observed_native_processes"]), 1)
        self.assertFalse(outcome["cleanup"]["forced_termination"])
        self.assertEqual(outcome["cleanup"]["remaining_observed_pids"], [])
        self.assertEqual(outcome["cleanup"]["unreaped_observed_pids"], [])

    def test_timeout_is_failure_and_does_not_kill_an_unrelated_process(self):
        outsider = subprocess.Popen(
            [sys.executable, "-c", "import time;time.sleep(10)"]
        )
        try:
            outcome = PAIRS.run_owned(
                [sys.executable, "-c", "import time;time.sleep(10)"],
                self.output,
                self.output / "timeout",
                0.2,
            )
            self.assertEqual(outcome["status"], "failed")
            self.assertEqual(outcome["error"]["type"], "TimeoutError")
            self.assertTrue(outcome["cleanup"]["forced_termination"])
            self.assertEqual(outcome["cleanup"]["remaining_observed_pids"], [])
            self.assertIsNone(outsider.poll())
        finally:
            outsider.terminate()
            outsider.wait(timeout=2)

    def test_log_overflow_is_retained_as_failure_with_bounded_disk_use(self):
        outcome = PAIRS.run_owned(
            [sys.executable, "-c", "import sys;sys.stdout.write('x'*(5*1024*1024))"],
            self.output,
            self.output / "overflow",
            3,
        )
        self.assertEqual(outcome["status"], "failed")
        self.assertGreater(outcome["logs"]["stdout"]["discarded_bytes"], 0)
        self.assertEqual(
            (self.output / "overflow/stdout.log").stat().st_size,
            PAIRS.DRIVER.MAX_LOG_BYTES,
        )

    def test_sigterm_cleans_the_owned_child_and_writes_failure_before_exit(self):
        code = """
import importlib.util, pathlib, sys
spec=importlib.util.spec_from_file_location('pairs',sys.argv[1])
pairs=importlib.util.module_from_spec(spec);spec.loader.exec_module(pairs)
pairs.DRIVER.enable_subreaper()
try:
    pairs.run_owned([sys.executable,'-c',"import os,time;print(os.getpid(),flush=True);time.sleep(30)"],pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[2])/'cancelled',20)
except InterruptedError:
    raise SystemExit(42)
"""
        controller = subprocess.Popen(
            [sys.executable, "-c", code, str(SCRIPT), str(self.output)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        observed = {}
        try:
            until = time.monotonic() + 5
            while True:
                rows = PAIRS.DRIVER.owned_processes(
                    controller.pid, PAIRS.DRIVER.process_table()
                )
                observed.update({row["pid"]: row["start_ticks"] for row in rows})
                children = [row for row in rows if row["parent_pid"] == controller.pid]
                if children:
                    break
                self.assertIsNone(
                    controller.poll(), "Controller exited before starting the trial"
                )
                if time.monotonic() >= until:
                    self.fail("Controller did not launch its child within 5 seconds")
                time.sleep(0.01)
            controller.send_signal(signal.SIGTERM)
            stdout, stderr = controller.communicate(timeout=6)
            self.assertEqual(controller.returncode, 42, (stdout, stderr))
            result = PAIRS.read_json(self.output / "cancelled/supervisor.json")
            self.assertEqual(result["error"]["type"], "InterruptedError")
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["cleanup"]["remaining_observed_pids"], [])
            self.assertEqual(result["cleanup"]["unreaped_observed_pids"], [])
        finally:
            PAIRS.DRIVER.cleanup(controller, observed)
            controller.stdout.close()
            controller.stderr.close()


if __name__ == "__main__":
    unittest.main()
