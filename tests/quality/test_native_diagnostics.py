"""Real-process signal-target guards; these are not native GUI tests."""

import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest


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
                "import subprocess,sys; "
                "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(20)']); "
                "print(child.pid,flush=True); child.wait()",
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


if __name__ == "__main__":
    unittest.main()
