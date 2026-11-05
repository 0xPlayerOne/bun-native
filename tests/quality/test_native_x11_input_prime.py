"""Headless tests for the XTest keyboard prime. No X server is used."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/quality/native-x11-input-prime.py"
SPEC = importlib.util.spec_from_file_location("native_x11_input_prime", SCRIPT)
PRIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PRIME)


class FakeSession:
    """Each key may switch the keyboard; each barrier may be answered."""

    def __init__(self, switches_per_key, answers):
        self.switches_per_key = list(switches_per_key)
        self.answers = list(answers)
        self.switches = 0
        self.calls = []
        self.closed = False

    def send_key(self):
        self.calls.append("key")
        self.pending = self.switches_per_key.pop(0)

    def window_manager_barrier(self, _deadline):
        self.calls.append("barrier")
        # Switch notifications precede the WM answer in server order.
        self.switches += self.pending
        return self.answers.pop(0)

    def close(self):
        self.closed = True


def run(session):
    with tempfile.TemporaryDirectory() as directory:
        report_path = Path(directory) / "prime.json"
        status = PRIME.main(
            ["--report", str(report_path)],
            open_session=lambda: session,
            send_key=session.send_key,
        )
        return status, json.loads(report_path.read_text())


class PrimeTests(unittest.TestCase):
    def test_fresh_server_switch_is_settled_before_test_input(self):
        session = FakeSession([1, 0], [True, True])
        status, report = run(session)
        self.assertEqual(status, 0)
        self.assertEqual(report["status"], "settled")
        self.assertEqual(report["first_key_keyboard_switches"], 1)
        self.assertEqual(report["control_key_keyboard_switches"], 0)
        # Every key is followed by a WM barrier before anything else runs.
        self.assertEqual(session.calls, ["key", "barrier", "key", "barrier"])
        self.assertTrue(session.closed)

    def test_unanswered_barrier_fails_without_retry(self):
        session = FakeSession([1, 0], [False, True])
        status, report = run(session)
        self.assertEqual(status, 1)
        self.assertEqual(report["status"], "failed")
        self.assertIn("did not answer the keyboard barrier", report["error"])
        self.assertEqual(session.calls, ["key", "barrier"])
        self.assertTrue(session.closed)

    def test_repeated_switch_is_a_failure(self):
        # Regression control: if a later key could still switch the keyboard,
        # a test's close shortcut could still race the WM rebind.
        session = FakeSession([1, 1], [True, True])
        status, report = run(session)
        self.assertEqual(status, 1)
        self.assertEqual(report["control_key_keyboard_switches"], 1)
        self.assertIn("switched the keyboard again", report["error"])

    def test_session_primes_after_wm_readiness_and_before_any_command(self):
        text = (ROOT / "scripts/quality/native-linux-session.sh").read_text()
        ready = text.index("xprop -root _NET_SUPPORTING_WM_CHECK | grep -q")
        prime = text.index("scripts/quality/native-x11-input-prime.py")
        first_command = text.index('if [[ "$mode" == -- ]]; then')
        self.assertLess(ready, prime)
        self.assertLess(prime, first_command)


if __name__ == "__main__":
    unittest.main()
