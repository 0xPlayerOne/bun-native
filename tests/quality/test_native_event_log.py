"""Incremental evidence reading and the /proc process table.

`EventLog` must give exactly what a fresh `read_events` gives at every step, so
every case compares the two. These tests start no native window.
"""

import json
import os
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.quality.native_harness import native_input_linux as DRIVER


def record(index, nonce="run"):
    return json.dumps({"nonce": nonce, "type": "input", "value": index}) + "\n"


class EventLogTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "events.jsonl"

    def outcome(self, call):
        try:
            return ("ok", call())
        except (RuntimeError, ValueError) as error:
            return (type(error).__name__, str(error))

    def assert_same(self, log, offset=0):
        fresh = self.outcome(lambda: DRIVER.read_events(self.path, log.nonce, offset))
        incremental = self.outcome(log.read)
        self.assertEqual(incremental, fresh)

    def test_matches_a_fresh_read_through_appends_and_a_partial_record(self):
        log = DRIVER.EventLog(self.path, "run")
        self.assert_same(log)  # no file yet
        with self.path.open("w") as output:
            output.write(record(0) + record(1))
            output.flush()
            self.assert_same(log)
            output.write('{"nonce":"run","type":"inp')  # unfinished final record
            output.flush()
            self.assert_same(log)
            self.assertEqual(len(log.read()), 2)
            output.write('ut","value":2}\n')
            output.flush()
            self.assert_same(log)
            self.assertEqual([event["value"] for event in log.read()], [0, 1, 2])
            for index in range(3, 40):
                output.write(record(index))
                output.flush()
                self.assert_same(log)

    def test_only_new_records_are_parsed(self):
        self.path.write_text(record(0) + record(1))
        log = DRIVER.EventLog(self.path, "run")
        log.read()
        with self.path.open("a") as output:
            output.write(record(2))
        calls = []
        real = DRIVER.json.loads

        def counting(line):
            calls.append(line)
            return real(line)

        DRIVER.json.loads = counting
        try:
            events = log.read()
        finally:
            DRIVER.json.loads = real
        self.assertEqual([event["value"] for event in events], [0, 1, 2])
        self.assertEqual(len(calls), 1)

    def test_returned_list_is_new_on_every_call(self):
        self.path.write_text(record(0))
        log = DRIVER.EventLog(self.path, "run")
        first = log.read()
        first.append("modified by the caller")
        self.assertEqual(len(log.read()), 1)

    def test_rewrite_truncation_and_deletion_reparse_from_the_start(self):
        log = DRIVER.EventLog(self.path, "run")
        self.path.write_text(record(0) + record(1) + record(2))
        self.assert_same(log)
        # Same length prefix, different bytes.
        self.path.write_text(record(5) + record(6) + record(7) + record(8))
        self.assert_same(log)
        self.assertEqual([event["value"] for event in log.read()], [5, 6, 7, 8])
        self.path.write_text(record(9))
        self.assert_same(log)
        self.assertEqual([event["value"] for event in log.read()], [9])
        self.path.write_text("")
        self.assert_same(log)
        self.path.write_text(record(1) + record(2))
        self.assert_same(log)
        self.path.unlink()
        self.assert_same(log)
        self.assertEqual(log.read(), [])
        self.path.write_text(record(3))
        self.assert_same(log)
        self.assertEqual([event["value"] for event in log.read()], [3])

    def test_bad_records_fail_every_time_until_the_file_changes(self):
        log = DRIVER.EventLog(self.path, "run")
        self.path.write_text(record(0))
        self.assert_same(log)
        with self.path.open("a") as output:
            output.write(record(1, nonce="other"))
        for _ in range(3):
            self.assert_same(log)
            with self.assertRaisesRegex(RuntimeError, "session nonce"):
                log.read()
        with self.path.open("a") as output:
            output.write("not json\n")
        for _ in range(2):
            self.assert_same(log)
        self.path.write_text(record(0) + "not json\n")
        self.assert_same(log)
        with self.assertRaises(ValueError):
            log.read()
        self.path.write_text(record(0) + record(1))
        self.assert_same(log)
        self.assertEqual(len(log.read()), 2)
        self.path.write_text(record(0) + "\n" + record(1))  # blank record
        self.assert_same(log)

    def test_oversized_evidence_raises_like_a_fresh_read(self):
        log = DRIVER.EventLog(self.path, "run")
        self.path.write_text(record(0))
        self.assert_same(log)
        self.path.write_bytes(b"x" * (DRIVER.MAX_LOG_BYTES + 1))
        self.assert_same(log)
        with self.assertRaisesRegex(RuntimeError, "4 MiB"):
            log.read()
        self.path.write_text(record(1))
        self.assert_same(log)

    def test_offset_skips_older_records_as_read_events_does(self):
        old = record(0) + record(1)
        self.path.write_text(old)
        offset = len(old.encode())
        log = DRIVER.EventLog(self.path, "run", offset)
        self.assert_same(log, offset)
        self.assertEqual(log.read(), [])
        with self.path.open("a") as output:
            output.write(record(2))
        self.assert_same(log, offset)
        with self.path.open("a") as output:
            output.write(record(3))
        self.assert_same(log, offset)
        self.assertEqual([event["value"] for event in log.read()], [2, 3])

    def test_matches_a_fresh_read_over_random_edits(self):
        state = 0x2545F4914F6CDD1D
        log = DRIVER.EventLog(self.path, "run")
        text = ""
        for step in range(400):
            state ^= (state << 13) & 0xFFFFFFFFFFFFFFFF
            state ^= state >> 7
            state ^= (state << 17) & 0xFFFFFFFFFFFFFFFF
            choice = state % 10
            if choice < 6:
                text += record(step)
            elif choice == 6:
                text += '{"nonce":"run"'
            elif choice == 7:
                text = text[: len(text) // 2]
            elif choice == 8 and text.endswith('{"nonce":"run"'):
                text += ',"type":"x"}\n'
            else:
                text = record(step) if step % 2 else ""
            self.path.write_text(text)
            self.assert_same(log)


class ProcessTableTests(unittest.TestCase):
    @staticmethod
    def reference():
        """The table as the original text-reading implementation built it."""
        result = {}
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                result[int(entry.name)] = {
                    "pid": int(entry.name),
                    "state": fields[0],
                    "parent_pid": int(fields[1]),
                    "process_group": int(fields[2]),
                    "start_ticks": int(fields[19]),
                    "rss_bytes": int(fields[21]) * os.sysconf("SC_PAGE_SIZE"),
                }
            except (OSError, ValueError, IndexError, ProcessLookupError):
                continue
        return result

    def test_rows_match_the_text_implementation_for_stable_processes(self):
        child = subprocess.Popen(["sleep", "30"])
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        table = DRIVER.process_table()
        reference = self.reference()
        for pid in (os.getpid(), child.pid):
            for key in ("pid", "parent_pid", "process_group", "start_ticks"):
                self.assertEqual(table[pid][key], reference[pid][key], (pid, key))
            self.assertEqual(
                set(table[pid]),
                {
                    "pid",
                    "state",
                    "parent_pid",
                    "process_group",
                    "start_ticks",
                    "rss_bytes",
                },
            )
            self.assertGreater(table[pid]["rss_bytes"], 0)
            self.assertEqual(table[pid]["rss_bytes"] % os.sysconf("SC_PAGE_SIZE"), 0)
        self.assertEqual(table[child.pid]["parent_pid"], os.getpid())

    def test_a_process_name_that_is_not_utf8_stays_in_the_table(self):
        child = subprocess.Popen(
            ["sh", "-c", r"printf '\377\376x' > /proc/self/comm; echo ready; sleep 30"],
            stdout=subprocess.PIPE,
        )
        self.addCleanup(child.wait)
        self.addCleanup(child.stdout.close)
        self.addCleanup(child.send_signal, signal.SIGKILL)
        self.assertEqual(child.stdout.readline().strip(), b"ready")
        raw = Path(f"/proc/{child.pid}/comm").read_bytes()
        if raw.startswith(b"x"):
            self.skipTest("this kernel refused the non-UTF-8 process name")
        row = DRIVER.process_table().get(child.pid)
        self.assertIsNotNone(row)
        self.assertEqual(row["parent_pid"], os.getpid())


if __name__ == "__main__":
    unittest.main()
