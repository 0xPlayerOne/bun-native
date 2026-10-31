"""Headless allocation-runner boundaries, not native GUI/profiler qualification."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
import warnings


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/quality/native-allocation-linux.py"
SPEC = importlib.util.spec_from_file_location("native_allocation", SCRIPT)
ALLOCATION = importlib.util.module_from_spec(SPEC) if sys.platform == "linux" else None
if ALLOCATION is not None:
    SPEC.loader.exec_module(ALLOCATION)


@unittest.skipUnless(sys.platform == "linux", "Linux allocation-runner limits")
class AllocationLimitsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name)
        self.previous_alarm = signal.signal(signal.SIGALRM, self.deadline)
        self.previous_term = signal.getsignal(signal.SIGTERM)
        signal.alarm(10)
        self.addCleanup(self.restore_signals)
        # libc is already mapped by this test process. This substitutes only a
        # harmless existing shared library for wrapper tests; it is not heaptrack.
        self.library = next(
            Path(fields[5])
            for line in Path("/proc/self/maps").read_text().splitlines()
            if len(fields := line.split(None, 5)) == 6
            and Path(fields[5]).name == "libc.so.6"
        )

    @staticmethod
    def deadline(_signum, _frame):
        raise TimeoutError("Allocation boundary test exceeded ten seconds")

    def restore_signals(self):
        signal.alarm(0)
        signal.signal(signal.SIGALRM, self.previous_alarm)
        signal.signal(signal.SIGTERM, self.previous_term)

    def wrapper(self, executable, limit=4096):
        path = self.output / "wrapper"
        ALLOCATION.write_host_wrapper(
            path,
            Path(executable).resolve(),
            self.library,
            self.output / "identity.json",
            limit,
        )
        return path

    def test_file_limit_terminates_exec_target_instead_of_silent_truncation(self):
        writer = shutil.which("dd")
        if writer is None:
            self.skipTest("Coreutils dd is required for the bounded native writer")
        destination = self.output / "bounded-output"
        result = subprocess.run(
            [
                str(self.wrapper(writer)),
                "if=/dev/zero",
                f"of={destination}",
                "bs=8192",
                "count=1",
                "status=none",
            ],
            capture_output=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, -signal.SIGXFSZ, result.stderr)
        self.assertLessEqual(destination.stat().st_size, 4096)
        self.assertEqual(result.stdout, b"")
        self.assertTrue((self.output / "identity.json").is_file())
        self.assertFalse((self.output / "core").exists())

    def test_exec_wrapper_preserves_stdout_arguments_and_atomic_identity(self):
        printer = shutil.which("printf")
        if printer is None:
            self.skipTest("Coreutils printf is required")
        payload = 'literal $HOME $(not-a-command) `also-literal` "quotes"\n'
        result = subprocess.run(
            [str(self.wrapper(printer)), "%s", payload],
            capture_output=True,
            timeout=5,
            check=True,
        )
        self.assertEqual(result.stdout.decode(), payload)
        self.assertEqual(result.stderr, b"")
        identity = json.loads((self.output / "identity.json").read_text())
        self.assertGreater(identity["pid"], 0)
        self.assertGreater(identity["start_ticks"], 0)
        self.assertFalse((self.output / "identity.json.tmp").exists())

    def test_postprocessor_preserves_a_stricter_inherited_file_limit(self):
        code = (
            "import importlib.util, resource; "
            f"s=importlib.util.spec_from_file_location('allocation', {str(SCRIPT)!r}); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "resource.setrlimit(resource.RLIMIT_FSIZE, (1024, 1024)); "
            "m.limit_file_output(); "
            "assert resource.getrlimit(resource.RLIMIT_FSIZE) == (1024,1024); "
            "assert resource.getrlimit(resource.RLIMIT_CORE) == (0,0)"
        )
        result = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, timeout=5
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_interrupted_interpretation_reaps_child_and_preserves_raw_trace(self):
        interpreter = self.output / "interpreter"
        pid_file = self.output / "interpreter.pid"
        interpreter.write_text(
            f"#!{sys.executable}\n"
            "import os, time\n"
            f"with open({str(pid_file)!r}, 'w') as stream: stream.write(str(os.getpid()))\n"
            "time.sleep(20)\n"
        )
        interpreter.chmod(0o700)
        raw = self.output / "native.raw"
        raw.write_bytes(b"bounded fake trace")
        signal.signal(signal.SIGALRM, ALLOCATION.interrupt)
        signal.alarm(1)
        with warnings.catch_warnings(record=True) as emitted:
            warnings.simplefilter("always", ResourceWarning)
            with self.assertRaises(InterruptedError):
                ALLOCATION.analyze(
                    self.output, interpreter, Path("unused"), Path("unused")
                )
        self.assertFalse(
            [warning for warning in emitted if warning.category is ResourceWarning]
        )
        signal.alarm(0)
        pid = int(pid_file.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertEqual(raw.read_bytes(), b"bounded fake trace")


@unittest.skipUnless(
    sys.platform == "linux" and ALLOCATION.DRIVER.proc_identity_matches(),
    "Requires a Linux PID namespace consistent with /proc",
)
class AllocationOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.previous_alarm = signal.signal(
            signal.SIGALRM, AllocationLimitsTests.deadline
        )
        signal.alarm(10)
        self.addCleanup(self.restore_alarm)
        ALLOCATION.DRIVER.enable_subreaper()
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import time; print('ready', flush=True); time.sleep(20)",
            ],
            stdout=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        self.observed = {}
        self.addCleanup(self.cleanup)
        self.assertEqual(self.process.stdout.readline(), "ready\n")

    def restore_alarm(self):
        signal.alarm(0)
        signal.signal(signal.SIGALRM, self.previous_alarm)

    def cleanup(self):
        result = ALLOCATION.cleanup_driver(self.process, self.observed)
        self.assertEqual(result["remaining_observed_pids"], [])
        self.assertEqual(result["unreaped_observed_pids"], [])
        self.process.stdout.close()

    def test_cancellation_before_first_sample_still_stops_launched_driver(self):
        self.assertEqual(self.observed, {})
        result = ALLOCATION.cleanup_driver(self.process, self.observed)
        self.assertTrue(result["forced_termination"])
        self.assertIsNotNone(self.process.poll())
        self.assertEqual(result["remaining_observed_pids"], [])

    def test_only_current_owned_identity_exact_executable_and_mapping_qualify(self):
        owned = ALLOCATION.sample_owned(self.process, self.observed)
        recorded = {
            "pid": self.process.pid,
            "start_ticks": owned[self.process.pid]["start_ticks"],
        }
        host = Path(sys.executable).resolve()
        library = next(
            Path(fields[5])
            for line in Path(f"/proc/{self.process.pid}/maps").read_text().splitlines()
            if len(fields := line.split(None, 5)) == 6
            and Path(fields[5]).name == "libc.so.6"
        )
        proof = ALLOCATION.observe_native_process(recorded, owned, host, library)
        self.assertTrue(proof["heaptrackMappingObserved"])
        for identity, rows, executable, mapped in [
            (recorded, {}, host, library),
            (
                {**recorded, "start_ticks": recorded["start_ticks"] + 1},
                owned,
                host,
                library,
            ),
            (recorded, owned, Path("/wrong-executable"), library),
            (recorded, owned, host, library.with_name("libc.so")),
        ]:
            with self.subTest(identity=identity, executable=executable, mapped=mapped):
                self.assertIsNone(
                    ALLOCATION.observe_native_process(
                        identity, rows, executable, mapped
                    )
                )

    def test_process_exit_between_sampling_and_proc_reads_supplies_no_proof(self):
        owned = ALLOCATION.sample_owned(self.process, self.observed)
        recorded = {
            "pid": self.process.pid,
            "start_ticks": owned[self.process.pid]["start_ticks"],
        }
        self.process.terminate()
        self.process.wait(timeout=3)
        self.assertIsNone(
            ALLOCATION.observe_native_process(
                recorded, owned, Path(sys.executable).resolve(), Path("/any-library")
            )
        )


if __name__ == "__main__":
    unittest.main()
