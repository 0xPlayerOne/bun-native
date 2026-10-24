"""Real process faults and deterministic boundary checks for the process observer."""

import importlib.util
import io
import sys
import tempfile
import threading
import time
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

spec = importlib.util.spec_from_file_location(
    "observer", Path(__file__).parents[1] / "scripts/observe-process.py"
)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTests(unittest.TestCase):
    def test_nonfinite_time_bounds_are_rejected_before_starting_a_process(self):
        with patch.object(observer.subprocess, "Popen") as spawn:
            for option in ("timeout", "interval"):
                for value in (float("nan"), float("inf"), float("-inf")):
                    with self.subTest(option=option, value=value), self.assertRaises(ValueError):
                        observer.observe(
                            [sys.executable, "-c", "raise RuntimeError"], **{option: value}
                        )
            spawn.assert_not_called()

    def test_interrupted_recognized_native_run_retains_failed_cleanup_evidence(self):
        def fail_callback(_tracker):
            raise RuntimeError("controlled qualification callback failure")

        for mode in ("timeout", "cancel", "callback"):
            with self.subTest(mode=mode):
                tracker = Mock()
                tracker.report.return_value = {
                    "passed": True,
                    "qualified": False,
                    "status": "not-observed",
                    "helpers": [],
                    "observedClones": 0,
                }
                stop = threading.Event()
                if mode == "cancel":
                    stop.set()
                with (
                    patch.object(observer.sys, "platform", "darwin"),
                    patch("macos_clone_cleanup.for_command", return_value=tracker),
                ):
                    result = observer.observe(
                        [sys.executable, "-c", "import time; time.sleep(30)"],
                        timeout=0.15 if mode == "timeout" else 5,
                        stop_event=stop,
                        cleanup_observer=fail_callback if mode == "callback" else None,
                    )
                cleanup = result["postExitCleanup"]
                self.assertEqual(cleanup["status"], "failed")
                self.assertFalse(cleanup["passed"])
                self.assertFalse(cleanup["qualified"])
                self.assertIn("resources", cleanup)
                self.assertEqual(result["cleanupSurvivors"], [])
                self.assertEqual(result["timedOut"], mode == "timeout")
                self.assertEqual(result["cancelled"], mode != "timeout")
                if mode == "callback":
                    self.assertEqual(result["observerFailure"], "cleanup-observer-failed")

    def test_stuck_qualified_helper_fails_after_its_bound_even_when_cleanup_succeeds(self):
        # Provenance is independently tested by the clone policy suite. Supply
        # an eligible identity here to exercise the observer's real deadline,
        # accounting and cleanup order without spending three wall-clock seconds.
        identity = (101, 2.0)
        elapsed_ms = 0
        killed_at = []

        def sleep(seconds):
            nonlocal elapsed_ms
            elapsed_ms += round(seconds * 1000)

        def kill():
            killed_at.append(elapsed_ms)

        helper = Mock()
        helper.oneshot.side_effect = nullcontext
        helper.cpu_times.return_value = SimpleNamespace(user=0.1, system=0.2)
        helper.memory_info.return_value = SimpleNamespace(rss=4096)
        helper.num_threads.return_value = 1
        helper.num_ctx_switches.return_value = SimpleNamespace(voluntary=1, involuntary=0)
        helper.num_fds.return_value = 3
        helper.num_handles.return_value = 3
        helper.name.return_value = "owned-fixture-helper"
        helper.ppid.return_value = 1
        helper.cmdline.return_value = ["--type=code-sign-clone-cleanup"]
        helper.kill.side_effect = kill
        root = Mock(pid=100)
        root.create_time.return_value = 1.0
        child = Mock(pid=100, stdout=io.BytesIO(), stderr=io.BytesIO())
        child.poll.return_value = 0
        child.wait.return_value = 0
        tracker = Mock()
        tracker.helpers = {identity: "abc123"}
        tracker.recover_after_exit.return_value = [(identity, helper)]
        tracker.grant.return_value = True
        tracker.state.return_value = "running"
        tracker.complete.return_value = False

        def cleanup_report(elapsed):
            self.assertFalse(killed_at, "Failure must be recorded before owned cleanup")
            return {
                "limitMs": 3000,
                "elapsedMs": elapsed,
                "passed": False,
                "qualified": False,
                "status": "failed",
                "helpers": [{"pid": identity[0], "processExited": False, "completed": False}],
                "observedClones": 1,
            }

        tracker.report.side_effect = cleanup_report
        with (
            patch.object(observer.sys, "platform", "darwin"),
            patch("macos_clone_cleanup.for_command", return_value=tracker),
            patch.object(observer.subprocess, "Popen", return_value=child),
            patch.object(observer.psutil, "Process", return_value=root),
            patch.object(
                observer,
                "owned_process",
                side_effect=lambda candidate: (
                    helper if candidate == identity and not killed_at else None
                ),
            ),
            patch.object(
                observer,
                "time",
                SimpleNamespace(monotonic=lambda: 100 + elapsed_ms / 1000, sleep=sleep),
            ),
        ):
            result = observer.observe(["controlled-native-fixture"], interval=0.033)

        self.assertEqual(len(killed_at), 1)
        self.assertGreater(killed_at[0], 3000)
        self.assertLess(killed_at[0], 3033)
        helper.kill.assert_called_once()
        child.kill.assert_not_called()
        self.assertEqual(result["observedOrphans"], [identity[0]])
        self.assertEqual(result["cleanupSurvivors"], [])
        self.assertEqual(result["exitCode"], 0)
        self.assertFalse(result["timedOut"])
        self.assertFalse(result["cancelled"])
        self.assertEqual(result["accounting"]["exitGraceMs"], 500)
        cleanup = result["postExitCleanup"]
        self.assertEqual(cleanup["limitMs"], 3000)
        self.assertAlmostEqual(cleanup["elapsedMs"], killed_at[0])
        self.assertEqual(cleanup["status"], "failed")
        self.assertFalse(cleanup["passed"])
        self.assertFalse(cleanup["qualified"])
        self.assertGreater(cleanup["resources"]["sampleCount"], 0)
        self.assertEqual(cleanup["resources"]["peakRssBytes"], 4096)

    def test_reused_pid_is_never_signalled_through_stale_ownership(self):
        foreign = Mock()
        foreign.create_time.return_value = 99.0
        with patch.object(observer.psutil, "Process", return_value=foreign):
            self.assertIsNone(observer.owned_process((123, 1.0)))
            observer.kill_owned((123, 1.0))
        foreign.kill.assert_not_called()

    def test_cleanup_metrics_do_not_join_reused_pid_lifetimes(self):
        def sample(birth, cpu):
            return {
                "phase": "post-exit-cleanup",
                "rssBytes": 123,
                "threads": 2,
                "processes": [{"pid": 9, "creationTime": birth, "cpuSeconds": cpu}],
            }

        result = observer.post_exit_resources([sample(1.0, 1.0), sample(2.0, 99.0)])
        self.assertIsNone(result["sampledCpuSeconds"])
        self.assertEqual(result["peakRssBytes"], 123)
        result = observer.post_exit_resources([sample(1.0, 1.0), sample(1.0, 1.25)])
        self.assertEqual(result["sampledCpuSeconds"], 0.25)

    def test_real_process_is_observed(self):
        # Wait for two actual sampler visits instead of assuming a 150 ms sleep
        # outlasts interpreter/sampler startup on a busy or emulated machine.
        # The first completed snapshot must exist before the child may exit.
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory) / "sampled"
            visits = 0

            def sampled(_pid):
                nonlocal visits
                visits += 1
                if visits == 1:
                    time.sleep(0.2)  # Reproduce observation slower than the old fixture.
                elif visits == 2:
                    release.write_text("observed", encoding="ascii")
                return {
                    "provider": "test-lifecycle-handshake",
                    "status": "unavailable",
                    "reason": "not a kernel counter",
                    "counters": [],
                    "expectedScopes": 0,
                    "sampledScopes": 0,
                }

            code = (
                "import time,json,sys; from pathlib import Path\n"
                "deadline=time.monotonic()+10\n"
                "while not Path(sys.argv[1]).exists():\n"
                " if time.monotonic()>deadline: raise RuntimeError('Sampler did not observe child')\n"
                " time.sleep(.01)\n"
                "print(json.dumps({'passed':True}))"
            )
            result = observer.observe(
                [sys.executable, "-c", code, str(release)],
                timeout=12,
                counter_reader=sampled,
            )
        self.assertGreaterEqual(visits, 2)
        self.assertEqual(result["exitCode"], 0)
        self.assertFalse(result["timedOut"])
        self.assertTrue(result["reports"][-1]["passed"])
        self.assertGreater(result["peakTreeRssBytes"], 0)
        self.assertEqual(result["observedOrphans"], [])

    def test_large_bounded_json_report_is_not_split(self):
        result = observer.observe(
            [
                sys.executable,
                "-c",
                'import json; print(json.dumps({"passed":True,"data":"x"*100000}))',
            ]
        )
        self.assertTrue(result["reports"][-1]["passed"])
        self.assertEqual(len(result["reports"][-1]["data"]), 100000)

    def test_ready_receipt_is_one_bounded_monotonic_stderr_diagnostic(self):
        code = (
            'import json,sys,time; event={"event":"bunly.foundation.ready","payload":"private"}; '
            "print(json.dumps(event),flush=True); time.sleep(.05); "
            "print(json.dumps(event),file=sys.stderr,flush=True); "
            "print(json.dumps(event),file=sys.stderr,flush=True)"
        )
        result = observer.observe([sys.executable, "-c", code])
        self.assertEqual(len(result["eventTimes"]), 1)
        marker = result["eventTimes"][0]
        self.assertEqual(set(marker), {"event", "elapsedMs", "stream"})
        self.assertEqual(marker["event"], "bunly.foundation.ready")
        self.assertEqual(marker["stream"], "stderr")
        self.assertGreaterEqual(marker["elapsedMs"], 0)
        self.assertLessEqual(marker["elapsedMs"], result["elapsedMs"])
        self.assertEqual(result["observedOrphans"], [])

    def test_native_receipts_survive_noise_without_deduplicating_or_accepting_stdout(self):
        code = (
            'import json,sys; event={"event":"bunly.native.transport-throttle","rate":4,"completed":True}; '
            "print(json.dumps(event)); "
            "print(json.dumps(event),file=sys.stderr); "
            "print(json.dumps(event),file=sys.stderr); "
            'print(json.dumps({"event":"not-allowlisted"}),file=sys.stderr); '
            'print(json.dumps({"event":["bunly.host.shutdown"]}),file=sys.stderr); '
            '[print("ordinary diagnostic noise",file=sys.stderr) for _ in range(80)]'
        )
        result = observer.observe([sys.executable, "-c", code])
        self.assertFalse(result["outputOverflow"])
        self.assertEqual(len(result["nativeDiagnostics"]), 2)
        self.assertEqual(result["nativeDiagnostics"][0], result["nativeDiagnostics"][1])
        self.assertTrue(all(line == "ordinary diagnostic noise" for line in result["stderr"]))

    def test_native_receipt_count_line_and_total_bytes_fail_closed_on_overflow(self):
        for count, size in [(129, 1), (1, 17000), (8, 10000)]:
            with self.subTest(count=count, size=size):
                code = (
                    "import json,sys; "
                    f'event={{"event":"bunly.host.failure","payload":"x"*{size}}}; '
                    f"[print(json.dumps(event),file=sys.stderr) for _ in range({count})]"
                )
                result = observer.observe([sys.executable, "-c", code])
                self.assertTrue(result["outputOverflow"])
                self.assertLessEqual(len(result["nativeDiagnostics"]), 128)
                self.assertLessEqual(
                    sum(len(line.encode()) for line in result["nativeDiagnostics"]), 65536
                )

    def test_output_overflow_is_not_success(self):
        result = observer.observe([sys.executable, "-c", 'print("x"*3000000)'])
        self.assertTrue(result["outputOverflow"])

    def test_hang_is_bounded_and_not_a_success(self):
        result = observer.observe(
            [sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.15
        )
        self.assertTrue(result["timedOut"])
        self.assertNotEqual(result["exitCode"], 0)

    def test_crash_is_preserved_as_failure(self):
        result = observer.observe(
            [sys.executable, "-c", "import time,sys; time.sleep(.1); sys.exit(23)"]
        )
        self.assertEqual(result["exitCode"], 23)

    def test_orphan_is_detected_before_owned_cleanup(self):
        code = 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(.3)'
        result = observer.observe([sys.executable, "-c", code])
        self.assertGreaterEqual(result["observedProcesses"], 2)
        self.assertEqual(len(result["observedOrphans"]), 1)
        self.assertEqual(result["orphanDetails"][0]["pid"], result["observedOrphans"][0])
        self.assertTrue(result["orphanDetails"][0]["name"])
        self.assertNotIn("commandLine", result["orphanDetails"][0])

    def test_real_role_only_process_keeps_strict_orphan_policy(self):
        code = (
            'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",'
            '"import time; time.sleep(30)","--type=code-sign-clone-cleanup",'
            '"--unique-temp-dir-suffix=abc123"],stdout=subprocess.DEVNULL,'
            "stderr=subprocess.DEVNULL); time.sleep(.3)"
        )
        result = observer.observe([sys.executable, "-c", code])
        self.assertEqual(len(result["observedOrphans"]), 1)
        self.assertEqual(result["accounting"]["exitGraceMs"], 500)
        self.assertEqual(result["orphanDetails"][0]["browserRole"], "code-sign-clone-cleanup")
        self.assertEqual(result["cleanupSurvivors"], [])


if __name__ == "__main__":
    unittest.main()
