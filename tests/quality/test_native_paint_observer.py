"""Real Linux file-watch safety tests, without a native GUI or latency claim."""

import copy
import errno
import hashlib
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.quality.native_harness import native_paint_observer as OBSERVER

ROOT = Path(__file__).resolve().parents[2]

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


class PaintObserverFailureTests(unittest.TestCase):
    """Portable worker-error delivery controls; these do not qualify inotify."""

    def test_full_tree_validation_must_finish_before_original_deadline(self):
        # Exercise the real file reader/parser without claiming a Linux watch.
        # A pre-read clock check alone cannot bound later JSON/tree validation.
        for finished in (101.5, 102.0, 102.5):
            with (
                self.subTest(validation_finished=finished),
                tempfile.TemporaryDirectory() as directory,
                patch.object(OBSERVER.time, "monotonic", return_value=100) as clock,
            ):
                path = Path(directory) / "events.jsonl"
                path.write_bytes(encoded())
                observer = OBSERVER.PaintObserver(path, "run", EXPECTED, timeout=2)
                actual_match = OBSERVER.same_json

                def validate(
                    left, right, match=actual_match, end=finished, current_clock=clock
                ):
                    matched = match(left, right)
                    current_clock.return_value = end
                    return matched

                with path.open("rb") as source:
                    observer.file = source.fileno()
                    info = os.fstat(observer.file)
                    observer.identity = (info.st_dev, info.st_ino)
                    observer.offset = 0
                    observer.anchor = b""
                    observer.skip_partial = False
                    clock.return_value = 101
                    with patch.object(OBSERVER, "same_json", side_effect=validate):
                        if finished < observer.deadline:
                            observer._read_records()
                            self.assertIsNotNone(observer.observed)
                        else:
                            with self.assertRaisesRegex(TimeoutError, "deadline"):
                                observer._read_records()
                            self.assertIsNone(observer.observed)
                    self.assertEqual(observer.deadline, 102)

    def test_worker_failure_is_recorded_logged_and_rethrown_unchanged(self):
        for failure in [RuntimeError("controlled reader failure"), KeyboardInterrupt()]:
            with self.subTest(kind=type(failure).__name__):
                observer = OBSERVER.PaintObserver("unused", "run", EXPECTED, timeout=2)
                observer.notifications_fd = 10
                observer.cancel_read = 11
                observer.started_ns = time.monotonic_ns()
                with (
                    patch.object(OBSERVER.selectors, "DefaultSelector") as selector,
                    patch.object(OBSERVER.LOGGER, "exception") as report,
                ):
                    selector.return_value.__enter__.return_value.register.side_effect = failure
                    observer._observe()
                    self.assertTrue(observer.done.is_set())
                    self.assertIs(observer.failure, failure)
                    report.assert_called_once_with(
                        "Owned native paint observer reader failed"
                    )
                    with self.assertRaises(type(failure)) as raised:
                        observer.result(time.monotonic_ns())
                    self.assertIs(raised.exception, failure)


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
                        (
                            "import pathlib,sys\n"
                            "with pathlib.Path(sys.argv[1]).open('ab') as out: out.write(bytes.fromhex(sys.argv[2]))\n"
                            "sys.stdin.read(1)\n"
                        ),
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
        with self.assertRaises(OSError), self.observer():
            self.fail("A symlink must not be watched")
        self.path.unlink()
        os.mkfifo(self.path)
        with self.assertRaisesRegex(RuntimeError, "regular file"), self.observer():
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
        with (
            patch.object(OBSERVER, "MAX_NOTIFICATIONS", 0),
            self.observer() as observer,
        ):
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
            with (
                self.subTest(message=message),
                self.assertRaisesRegex(RuntimeError, message),
            ):
                OBSERVER.notification_count(data, 1)

    def test_deadline_and_cancellation_close_watched_descriptors_and_reader(self):
        observer = self.observer(timeout=0.05)
        with self.assertRaisesRegex(TimeoutError, "deadline"), observer:
            descriptors = list(observer.descriptors)
            observer.begin()
            observer.result(time.monotonic_ns())
        self.assert_closed(observer, descriptors)
        for begun in [False, True]:
            observer = self.observer()
            with self.assertRaisesRegex(RuntimeError, "input command failed"), observer:
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
            "import json,os,pathlib,signal,sys,time\n"
            "sys.path.insert(0,sys.argv[1])\n"
            "from scripts.quality.native_harness import native_paint_observer as module\n"
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
                str(ROOT),
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
