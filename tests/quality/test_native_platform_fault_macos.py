"""Pure process-ownership guards for the macOS native fault driver (#247)."""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

from scripts.quality.native_harness import native_fault_macos as FAULT

ROOT = Path(__file__).resolve().parents[2]


def row(pid, ppid, executable="/bin/x", state="S", started="Fri Nov 6 00:00:00 2026"):
    return {
        "pid": pid,
        "ppid": ppid,
        "state": state,
        "started": started,
        "executable": executable,
    }


class FakeApp:
    pid = 10


class MacosFaultOwnershipTests(unittest.TestCase):
    def test_owned_processes_are_descendants_only(self):
        table = {
            pid: row(pid, ppid)
            for pid, ppid in ((10, 1), (11, 10), (12, 11), (20, 1), (21, 20))
        }
        self.assertEqual(
            [item["pid"] for item in FAULT.owned_processes(10, table)], [11, 12]
        )

    def test_host_row_requires_exactly_one_live_owned_host(self):
        host = Path("/tmp/bun-native-host-test")
        for table, message in (
            ({10: row(10, 1)}, "found 0"),
            (
                {
                    10: row(10, 1),
                    11: row(11, 10, str(host)),
                    12: row(12, 10, str(host)),
                },
                "found 2",
            ),
            ({10: row(10, 1), 11: row(11, 10, str(host), state="Z")}, "found 0"),
            ({10: row(10, 1), 21: row(21, 99, str(host))}, "found 0"),
        ):
            with (
                mock.patch.object(FAULT, "process_table", return_value=table),
                self.assertRaisesRegex(RuntimeError, message),
            ):
                FAULT.host_row(FakeApp, host.resolve(), {})

    def test_host_row_rejects_a_reused_pid(self):
        host = Path("/tmp/bun-native-host-test").resolve()
        table = {10: row(10, 1), 11: row(11, 10, str(host))}
        observed = {11: "Fri Nov 6 00:00:01 2026"}
        with (
            mock.patch.object(FAULT, "process_table", return_value=table),
            self.assertRaisesRegex(RuntimeError, "identity changed"),
        ):
            FAULT.host_row(FakeApp, host, observed)

    def test_host_row_accepts_one_owned_host_and_records_its_identity(self):
        host = Path("/tmp/bun-native-host-test").resolve()
        table = {10: row(10, 1), 11: row(11, 10, str(host))}
        observed = {}
        with mock.patch.object(FAULT, "process_table", return_value=table):
            self.assertEqual(FAULT.host_row(FakeApp, host, observed)["pid"], 11)
        self.assertEqual(observed, {11: "Fri Nov 6 00:00:00 2026"})

    @unittest.skipUnless(sys.platform == "darwin", "ps(1) column layout is macOS")
    def test_the_real_process_table_parses_this_process(self):
        table = FAULT.process_table()
        self.assertIn(os.getpid(), table)
        self.assertTrue(table[os.getpid()]["started"])


if __name__ == "__main__":
    unittest.main()
