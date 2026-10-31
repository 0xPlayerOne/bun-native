"""Real Linux file-watch safety tests, without a native GUI or latency claim."""

import copy
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


SCRIPT = (
    Path(__file__).resolve().parents[2] / "scripts/quality/native-paint-observer.py"
)
SPEC = importlib.util.spec_from_file_location("native_paint_observer", SCRIPT)
OBSERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OBSERVER)
EXPECTED = {
    "type": "rendered",
    "stage": "native-paint",
    "window_id": 1,
    "tree_revision": 2,
    "nodes": [
        {
            "node_id": 1,
            "element": {"kind": "box", "style": {"padding": 24}},
            "children": [],
        }
    ],
}


def encoded(value=None):
    return (json.dumps({"nonce": "run", **(value or EXPECTED)}) + "\n").encode()


@unittest.skipUnless(sys.platform == "linux", "inotify is a Linux diagnostic")
class PaintObservationTests(unittest.TestCase):
    def setUp(self):
        self.previous_alarm = signal.signal(signal.SIGALRM, self.expired)
        signal.alarm(10)
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "events.jsonl"
        self.path.touch()

    def tearDown(self):
        self.directory.cleanup()
        signal.alarm(0)
        signal.signal(signal.SIGALRM, self.previous_alarm)

    @staticmethod
    def expired(_signal, _frame):
        raise TimeoutError("Native paint safety test exceeded 10 seconds")

    def observer(self, timeout=2):
        return OBSERVER.PaintObserver(self.path, "run", EXPECTED, timeout=timeout)

    def append(self, data):
        with self.path.open("ab") as output:
            output.write(data)

    def assert_closed(self, observer, descriptors):
        self.assertFalse(observer.thread and observer.thread.is_alive())
        self.assertEqual(observer.descriptors, [])
        for descriptor in descriptors:
            with self.assertRaises(OSError) as error:
                os.fstat(descriptor)
            self.assertEqual(error.exception.errno, errno.EBADF)

    def test_reads_complete_paint_while_real_command_process_is_still_running(self):
        process = None
        observer = self.observer()
        try:
            with observer:
                descriptors = list(observer.descriptors)
                observer.begin()
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        "import pathlib,sys\n"
                        "with pathlib.Path(sys.argv[1]).open('ab') as out: out.write(bytes.fromhex(sys.argv[2]))\n"
                        "sys.stdin.read(1)\n",
                        str(self.path),
                        encoded().hex(),
                    ],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                self.assertTrue(observer.done.wait(2))
                self.assertIsNone(process.poll(), "Writer must still be awaiting input")
                process.stdin.write(b"x")
                process.stdin.close()
                self.assertEqual(process.wait(timeout=2), 0)
                result = observer.result(time.monotonic_ns())
                self.assertTrue(result["observed_before_input_commands_returned"])
                self.assertLess(
                    result["command_start_to_paint_observed_ms"],
                    result["command_start_to_input_commands_returned_ms"],
                )
                self.assertEqual(
                    result["paint"]["record_sha256"],
                    hashlib.sha256(encoded()).hexdigest(),
                )
                self.assertEqual(result["paint"]["tree_revision"], 2)
                self.assertEqual(result["validated_records"], 1)
            self.assert_closed(observer, descriptors)
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=2)
                process.stdin.close()
                process.stderr.close()

    def test_new_record_requires_newline_and_preexisting_partial_record_is_ineligible(
        self,
    ):
        self.path.write_bytes(encoded()[:-1])
        with self.observer() as observer:
            observer.begin()
            self.append(b"\n")
            self.assertFalse(observer.done.wait(0.03))
            self.append(encoded()[:-1])
            self.assertFalse(observer.done.wait(0.03))
            self.append(b"\n")
            result = observer.result(time.monotonic_ns())
            self.assertTrue(result["ignored_preexisting_partial_record"])
            self.assertEqual(result["validated_records"], 1)

    def test_full_state_window_revision_stage_and_numeric_types_must_match(self):
        wrong_node = copy.deepcopy(EXPECTED)
        wrong_node["nodes"][0]["node_id"] = True
        alternatives = [
            {**EXPECTED, "window_id": True},
            {**EXPECTED, "window_id": 2},
            {**EXPECTED, "tree_revision": 1},
            {**EXPECTED, "tree_revision": True},
            {**EXPECTED, "nodes": []},
            {**EXPECTED, "stage": "bun-application"},
            {**EXPECTED, "status": "omitted"},
            wrong_node,
        ]
        with self.observer() as observer:
            observer.begin()
            self.append(b"".join(encoded(item) for item in alternatives))
            self.assertFalse(observer.done.wait(0.03))
            equivalent_numbers = copy.deepcopy(EXPECTED)
            equivalent_numbers["nodes"][0]["element"]["style"]["padding"] = 24.0
            self.append(encoded(equivalent_numbers))
            self.assertTrue(
                observer.result(time.monotonic_ns())["paint"][
                    "complete_expected_tree_matched"
                ]
            )

    def test_foreign_nonce_malformed_duplicate_and_non_finite_records_fail(self):
        for data in [
            b'{"nonce":"another-run"}\n',
            b'{"nonce":"run", invalid}\n',
            b'{"nonce":"run","nonce":"run"}\n',
            b'{"nonce":"run","value":NaN}\n',
            b'["run"]\n',
        ]:
            with self.subTest(data=data):
                self.path.write_bytes(b"")
                with self.observer() as observer:
                    observer.begin()
                    self.append(data)
                    with self.assertRaisesRegex(RuntimeError, "nonce|record"):
                        observer.result(time.monotonic_ns())

    def test_overflow_exponents_cannot_hide_in_a_matching_paint(self):
        for number in (b"1e999", b"-1e999"):
            with self.subTest(number=number):
                self.path.write_bytes(b"")
                with self.observer() as observer:
                    observer.begin()
                    self.append(encoded()[:-2] + b',"extra_number":' + number + b"}\n")
                    with self.assertRaisesRegex(
                        RuntimeError, "Invalid complete native evidence record"
                    ):
                        observer.result(time.monotonic_ns())
        self.path.write_bytes(b"")
        with self.observer() as observer:
            observer.begin()
            self.append(encoded()[:-2] + b',"extra_number":1e308}\n')
            self.assertTrue(
                observer.result(time.monotonic_ns())["paint"][
                    "complete_expected_tree_matched"
                ]
            )

    def test_truncation_rewrite_and_path_replacement_fail(self):
        for change in ["truncate", "rewrite", "replace"]:
            with self.subTest(change=change):
                self.path.write_bytes(encoded())
                with self.observer() as observer:
                    observer.begin()
                    if change == "truncate":
                        self.path.write_bytes(b"")
                    elif change == "rewrite":
                        self.path.write_bytes(b"x" * len(encoded()))
                    else:
                        replacement = self.path.with_suffix(".new")
                        replacement.write_bytes(encoded())
                        replacement.replace(self.path)
                    with self.assertRaisesRegex(
                        RuntimeError, "truncated|changed|removed"
                    ):
                        observer.result(time.monotonic_ns())

    def test_symlink_and_non_regular_log_fail_without_descriptor_leaks(self):
        original = self.path.with_suffix(".original")
        self.path.rename(original)
        self.path.symlink_to(original)
        baseline = len(list(Path("/proc/self/fd").iterdir()))
        with self.assertRaises(OSError):
            with self.observer():
                self.fail("A symlink must not be watched")
        self.path.unlink()
        os.mkfifo(self.path)
        with self.assertRaisesRegex(RuntimeError, "regular file"):
            with self.observer():
                self.fail("A FIFO must not be watched")
        self.assertEqual(len(list(Path("/proc/self/fd").iterdir())), baseline)

    def test_log_and_complete_or_partial_record_limits_fail_closed(self):
        for kind in ["log", "complete", "partial"]:
            with self.subTest(kind=kind):
                self.path.write_bytes(b"")
                with self.observer() as observer:
                    observer.begin()
                    if kind == "log":
                        with self.path.open("ab") as output:
                            output.truncate(OBSERVER.MAX_LOG_BYTES + 1)
                    else:
                        self.append(
                            b"x" * (OBSERVER.MAX_RECORD_BYTES + 1)
                            + (b"\n" if kind == "complete" else b"")
                        )
                    with self.assertRaisesRegex(RuntimeError, "limit|bound|exceeded"):
                        observer.result(time.monotonic_ns())

    def test_native_record_limit_excludes_the_jsonl_newline(self):
        value = {"nonce": "run", **EXPECTED, "padding": ""}
        size = len(json.dumps(value).encode())
        value["padding"] = "x" * (OBSERVER.MAX_RECORD_BYTES - size)
        record = (json.dumps(value) + "\n").encode()
        self.assertEqual(len(record), OBSERVER.MAX_RECORD_BYTES + 1)
        with self.observer() as observer:
            observer.begin()
            self.append(record[:-1])
            self.assertFalse(observer.done.wait(0.03))
            self.append(record[-1:])
            result = observer.result(time.monotonic_ns())
            self.assertEqual(
                result["paint"]["record_sha256"], hashlib.sha256(record).hexdigest()
            )

    def test_real_watch_notification_budget_and_overflow_record_are_errors(self):
        with patch.object(OBSERVER, "MAX_NOTIFICATIONS", 0):
            with self.observer() as observer:
                observer.begin()
                self.append(encoded())
                with self.assertRaisesRegex(RuntimeError, "notification budget"):
                    observer.result(time.monotonic_ns())
        cases = [
            (OBSERVER.EVENT.pack(-1, OBSERVER.IN_Q_OVERFLOW, 0, 0), "overflow"),
            (b"short", "Truncated"),
            (OBSERVER.EVENT.pack(1, OBSERVER.IN_MODIFY, 0, 4), "Truncated"),
            (OBSERVER.EVENT.pack(2, OBSERVER.IN_MODIFY, 0, 0), "identity"),
            (OBSERVER.EVENT.pack(1, OBSERVER.IN_DELETE_SELF, 0, 0), "removed"),
        ]
        for data, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(RuntimeError, message):
                    OBSERVER.notification_count(data, 1)

    def test_deadline_and_cancellation_close_watched_descriptors_and_reader(self):
        observer = self.observer(timeout=0.05)
        with self.assertRaisesRegex(TimeoutError, "deadline"):
            with observer:
                descriptors = list(observer.descriptors)
                observer.begin()
                observer.result(time.monotonic_ns())
        self.assert_closed(observer, descriptors)
        for begun in [False, True]:
            observer = self.observer()
            with self.assertRaisesRegex(RuntimeError, "input command failed"):
                with observer:
                    descriptors = list(observer.descriptors)
                    if begun:
                        observer.begin()
                    raise RuntimeError("input command failed")
            self.assert_closed(observer, descriptors)

    def test_preparation_and_begin_cannot_restart_the_remaining_fixture_deadline(self):
        for expired_before_begin in [True, False]:
            with self.subTest(expired_before_begin=expired_before_begin):
                self.path.write_bytes(b"")
                with patch.object(
                    OBSERVER.time, "monotonic", return_value=100
                ) as clock:
                    observer = self.observer(timeout=2)
                    with observer:
                        descriptors = list(observer.descriptors)
                        if expired_before_begin:
                            clock.return_value = 102.5
                            with self.assertRaisesRegex(TimeoutError, "deadline"):
                                observer.begin()
                        else:
                            clock.return_value = 101
                            observer.begin()
                            clock.return_value = 102.5
                            self.append(encoded())
                            with self.assertRaisesRegex(TimeoutError, "deadline"):
                                observer.result(time.monotonic_ns())
                    self.assert_closed(observer, descriptors)

    def test_sigterm_interrupts_and_joins_a_real_blocked_reader_process(self):
        report = self.path.with_suffix(".cleanup.json")
        script = (
            "import importlib.util,json,os,pathlib,signal,sys,time\n"
            "spec=importlib.util.spec_from_file_location('observer',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\n"
            "def stop(*args): raise InterruptedError('cancelled')\n"
            "signal.signal(signal.SIGTERM,stop)\n"
            "baseline=len(list(pathlib.Path('/proc/self/fd').iterdir()))\n"
            "observer=module.PaintObserver(sys.argv[2],'run',json.loads(sys.argv[3]),timeout=8)\n"
            "try:\n"
            " with observer:\n"
            "  observer.begin(); print('ready',flush=True); observer.result(time.monotonic_ns())\n"
            "except InterruptedError:\n"
            " pathlib.Path(sys.argv[4]).write_text(json.dumps({'alive':observer.thread.is_alive(),'descriptors':observer.descriptors,'fd_delta':len(list(pathlib.Path('/proc/self/fd').iterdir()))-baseline}))\n"
        )
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                script,
                str(SCRIPT),
                str(self.path),
                json.dumps(EXPECTED),
                str(report),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            ready, _, _ = select.select([process.stdout], [], [], 3)
            self.assertTrue(ready)
            self.assertEqual(process.stdout.readline().strip(), "ready")
            process.send_signal(signal.SIGTERM)
            _stdout, stderr = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(
                json.loads(report.read_text()),
                {"alive": False, "descriptors": [], "fd_delta": 0},
            )
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=2)
            process.stdout.close()
            process.stderr.close()


if __name__ == "__main__":
    unittest.main()
