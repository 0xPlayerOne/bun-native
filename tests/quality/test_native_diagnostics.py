"""Real-process signal-target guards; these are not native GUI tests."""

import hashlib
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_diagnostics", ROOT / "scripts/quality/native-diagnostics-linux.py"
)
DIAGNOSTICS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAGNOSTICS)
DRIVER = DIAGNOSTICS.DRIVER


@unittest.skipUnless(
    sys.platform == "linux" and DRIVER.proc_identity_matches(),
    "Requires a Linux PID namespace consistent with /proc",
)
class NativeSignalOwnershipTests(unittest.TestCase):
    def setUp(self):
        DRIVER.enable_subreaper()
        self.previous_alarm = signal.signal(signal.SIGALRM, self.deadline)
        signal.alarm(10)
        self.sibling = None
        self.app = None
        self.observed = {}
        self.addCleanup(self.cleanup)
        self.app = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import subprocess,sys; "
                    "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(20)']); "
                    "print(child.pid,flush=True); child.wait()"
                ),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        self.child = int(self.app.stdout.readline())
        self.observed = {
            row["pid"]: row["start_ticks"]
            for row in DRIVER.owned_processes(self.app.pid, DRIVER.process_table())
        }
        self.executable = Path(sys.executable).resolve()

    @staticmethod
    def deadline(_signum, _frame):
        raise TimeoutError("Native signal guard test exceeded ten seconds")

    def cleanup(self):
        try:
            if self.sibling is not None:
                self.sibling.terminate()
                self.sibling.wait(timeout=2)
            if self.app is not None:
                result = DRIVER.cleanup(self.app, self.observed)
                self.assertEqual(result["remaining_observed_pids"], [])
                self.assertEqual(result["unreaped_observed_pids"], [])
                self.app.stdout.close()
                self.app.stderr.close()
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, self.previous_alarm)

    def test_foreign_child_is_rejected_even_with_its_correct_identity(self):
        self.sibling = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(20)"],
            start_new_session=True,
        )
        table = DRIVER.process_table()
        claimed = {
            **self.observed,
            self.sibling.pid: table[self.sibling.pid]["start_ticks"],
        }
        with self.assertRaisesRegex(RuntimeError, "ownership or process identity"):
            DIAGNOSTICS.require_owned_host(
                self.app, claimed, self.sibling.pid, self.executable
            )
        self.assertIsNone(self.sibling.poll(), "Foreign process must remain alive")
        os.kill(self.child, 0)

    def test_reused_pid_identity_is_rejected_before_any_signal(self):
        changed = {**self.observed, self.child: self.observed[self.child] + 1}
        with self.assertRaisesRegex(RuntimeError, "ownership or process identity"):
            DIAGNOSTICS.require_owned_host(
                self.app, changed, self.child, self.executable
            )
        os.kill(self.child, 0)

    def test_owned_child_with_wrong_executable_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "explicitly supplied native host"):
            DIAGNOSTICS.require_owned_host(
                self.app, self.observed, self.child, Path("/bin/false").resolve()
            )
        os.kill(self.child, 0)


def process_row(pid, started, state="S"):
    return {"pid": pid, "start_ticks": started, "state": state}


class OwnedHostTableTests(unittest.TestCase):
    """Recorded-table guards; no process is started or signalled."""

    APP = Mock(pid=100)
    HOST = Path("/opt/native/bun-native-host")

    def check(self, table, observed, pid, image=HOST, owned=None):
        resolved = Mock()
        resolved.return_value.resolve.return_value = image
        rows = [table[item] for item in (owned or table) if item in table]
        with (
            patch.object(DRIVER, "process_table", return_value=table),
            patch.object(DRIVER, "owned_processes", return_value=rows) as owned_call,
            patch.object(DIAGNOSTICS, "Path", resolved),
        ):
            result = DIAGNOSTICS.require_owned_host(self.APP, observed, pid, self.HOST)
        owned_call.assert_called_once_with(100, table)
        resolved.assert_called_once_with(f"/proc/{pid}/exe")
        return result

    def test_owned_live_identity_with_the_supplied_executable_is_returned(self):
        table = {100: process_row(100, 1), 101: process_row(101, 2)}
        self.assertIs(self.check(table, {101: 2}, 101), table[101])

    def test_identity_failures_are_rejected_before_resolving_the_image(self):
        table = {
            100: process_row(100, 1),
            101: process_row(101, 2),
            102: process_row(102, 3, "Z"),
            103: process_row(103, 4),
        }
        observed = {100: 1, 101: 2, 102: 3, 103: 4}
        cases = (
            ("launched app itself", 100, observed, None),
            ("zombie host", 102, observed, None),
            ("unobserved host", 101, {}, None),
            ("changed start ticks", 101, {101: 9}, None),
            ("absent pid", 104, {104: 5}, None),
            ("not a descendant", 103, observed, [100, 101, 102]),
        )
        for name, pid, claimed, owned in cases:
            with (
                self.subTest(name),
                patch.object(DRIVER, "process_table", return_value=table),
                patch.object(
                    DRIVER,
                    "owned_processes",
                    return_value=[table[item] for item in (owned or table)],
                ),
                patch.object(DIAGNOSTICS, "Path") as resolved,
            ):
                with self.assertRaisesRegex(RuntimeError, "ownership or process"):
                    DIAGNOSTICS.require_owned_host(self.APP, claimed, pid, self.HOST)
                resolved.assert_not_called()

    def test_wrong_executable_is_rejected(self):
        table = {100: process_row(100, 1), 101: process_row(101, 2)}
        with self.assertRaisesRegex(RuntimeError, "explicitly supplied native host"):
            self.check(table, {101: 2}, 101, image=Path("/usr/bin/bun"))


class DiagnosticsHelperTests(unittest.TestCase):
    def test_fingerprint_hashes_streamed_content_and_size(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.ts"
            data = b"a" * (1024 * 1024 + 3)
            path.write_bytes(data)
            self.assertEqual(
                DIAGNOSTICS.fingerprint(path),
                {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)},
            )

    def test_interrupt_ignores_repeated_cancellation_during_cleanup(self):
        previous = {
            number: signal.getsignal(number)
            for number in (signal.SIGTERM, signal.SIGALRM)
        }
        self.addCleanup(
            lambda: [signal.signal(number, item) for number, item in previous.items()]
        )
        with self.assertRaisesRegex(InterruptedError, "received signal 15"):
            DIAGNOSTICS.interrupt(signal.SIGTERM, None)
        self.assertIs(signal.getsignal(signal.SIGTERM), signal.SIG_IGN)
        self.assertIs(signal.getsignal(signal.SIGALRM), signal.SIG_IGN)

    def test_every_scenario_name_is_unique_and_has_a_scenario_source(self):
        self.assertEqual(len(set(DIAGNOSTICS.SCENARIOS)), len(DIAGNOSTICS.SCENARIOS))
        sources = set(DIAGNOSTICS.source_snapshot.__code__.co_consts)
        for module in (
            "native-layout-scenario.py",
            "native-interactions-scenario.py",
            "native-clipboard-scenario.py",
            "native-react-workspace-scenario.py",
            "native-solid-workspace-scenario.py",
            "native-input-viewport-scenario.py",
        ):
            with self.subTest(module):
                self.assertIn(f"scripts/quality/{module}", sources)


class SchedulingEvidenceBudgetTests(unittest.TestCase):
    """The scheduling stream's native evidence is bounded by its command count."""

    source = (ROOT / "tests/native/scheduling.ts").read_text()

    def constant(self, name):
        found = re.search(rf"^const {name} = ([\d_]+)$", self.source, re.MULTILINE)
        self.assertIsNotNone(found, f"scheduling.ts must declare const {name}")
        return int(found.group(1).replace("_", ""))

    def test_command_cap_bounds_native_evidence_far_below_the_unchanged_limit(self):
        cap = self.constant("maximumCommands")
        # Mount, filler and completion batches precede and follow the stream.
        revisions = cap + 64
        self.assertLess(revisions, 100_000)
        # One host `batch_applied` record per command, at its widest: a five digit
        # revision, the 1,031 node tree and a ten digit preflight time.
        record = json.dumps(
            {
                "nonce": "f" * 32,
                "type": "batch_applied",
                "window_id": 1,
                "tree_revision": 99_999,
                "operation_count": 1,
                "node_count": 1031,
                "text_bytes": 99_999,
                "preflight_nanos": 9_999_999_999,
            },
            separators=(",", ":"),
        )
        batches = cap * (len(record) + 1)
        # Paint, layout, renderer and close records scale with frames, not
        # commands; hosted runs wrote about 46 KB of them over the whole stream.
        other = 256 * 1024
        self.assertLessEqual(batches + other, DRIVER.MAX_LOG_BYTES * 3 // 4)

    def test_saturation_release_precedes_the_end_of_the_stream(self):
        cap = self.constant("maximumCommands")
        self.assertEqual(self.constant("pendingLimit"), 128)
        self.assertLessEqual(self.constant("saturationPoint"), cap // 2)
        self.assertLess(
            self.constant("saturationDelayMs"), self.constant("producerDeadlineMs")
        )

    def test_the_serial_control_stays_bounded_by_its_deadline(self):
        # Each control command is followed by a 1 ms application yield.
        self.assertIn("await Bun.sleep(1)", self.source)
        self.assertLessEqual(self.constant("producerDeadlineMs"), 3000)


if __name__ == "__main__":
    unittest.main()
