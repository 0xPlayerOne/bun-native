"""Kernel ABI bounds and an unprivileged real reparenting check on macOS."""

import ctypes
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import suppress
from pathlib import Path
from unittest.mock import Mock, patch

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from macos_process_identity import (  # noqa: E402
    MAX_PID_CANDIDATES,
    KernelIdentity,
    MacProcessIds,
    decode_identity,
)


class KernelAbiTests(unittest.TestCase):
    def test_exact_abi_preserves_64_bit_identifiers(self):
        raw = struct.pack("=16sQQiiQQ", b"a" * 16, 2**63 + 1, 2**63, 3, 2, 0, 0)
        self.assertEqual(decode_identity(raw), KernelIdentity(2**63 + 1, 2**63, 3, b"a" * 16))

    def test_short_zero_or_negative_kernel_identity_does_not_establish_provenance(self):
        for raw in (
            b"",
            bytes(55),
            bytes(57),
            bytes(56),
            struct.pack("=16sQQiiQQ", b"a" * 16, 2, 0, 1, 1, 0, 0),
            struct.pack("=16sQQiiQQ", b"a" * 16, 2, 1, -1, 1, 0, 0),
        ):
            self.assertIsNone(decode_identity(raw))

    def test_unsupported_kernel_reply_is_not_an_identity(self):
        reader = MacProcessIds.__new__(MacProcessIds)
        for size in (0, -1, 55, 57):
            reader._pidinfo = Mock(return_value=size)
            self.assertIsNone(reader.identity(123))
            reader._pidinfo.assert_called_once()

    @patch("macos_process_identity.os.getuid", return_value=123, create=True)
    def test_inventory_overflow_and_malformed_reply_fail_with_one_fixed_buffer(self, _uid):
        reader = MacProcessIds.__new__(MacProcessIds)
        for size in (0, -1, 3, (MAX_PID_CANDIDATES + 1) * ctypes.sizeof(ctypes.c_int)):
            reader._listpids = Mock(return_value=size)
            with self.assertRaises(ValueError):
                reader.same_uid_pids()
            arguments = reader._listpids.call_args.args
            self.assertEqual(arguments[0], 5)
            self.assertEqual(arguments[1], 123)
            self.assertEqual(len(arguments[2]), MAX_PID_CANDIDATES + 1)
            reader._listpids.assert_called_once()

    @patch("macos_process_identity.os.getuid", return_value=123, create=True)
    def test_inventory_accepts_only_positive_unique_kernel_pids(self, _uid):
        reader = MacProcessIds.__new__(MacProcessIds)

        def fill(_flavor, _uid, buffer, _size):
            buffer[0], buffer[1] = 12, 34
            return 8

        reader._listpids = fill
        self.assertEqual(reader.same_uid_pids(), [12, 34])

        def duplicate(_flavor, _uid, buffer, _size):
            buffer[0], buffer[1] = 12, 12
            return 8

        reader._listpids = duplicate
        with self.assertRaises(ValueError):
            reader.same_uid_pids()


@unittest.skipUnless(sys.platform == "darwin", "unprivileged libproc requires macOS")
class NativeParentIdentityTests(unittest.TestCase):
    def test_original_parent_unique_id_survives_reparenting(self):
        reader = MacProcessIds()
        code = (
            "import pathlib,subprocess,sys; "
            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(10)'],"
            "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
            "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); sys.stdin.readline()"
        )
        child_identity = child_kernel = None
        with tempfile.TemporaryDirectory(prefix="bunly-parent-identity-") as directory:
            ready = Path(directory) / "child-pid"
            parent = subprocess.Popen(
                [sys.executable, "-c", code, str(ready)],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "controlled child did not start")
                pid = int(ready.read_text())
                child_identity = (pid, psutil.Process(pid).create_time())
                parent_kernel = reader.identity(parent.pid)
                child_kernel = reader.identity(pid)
                self.assertIsNotNone(parent_kernel)
                self.assertIsNotNone(child_kernel)
                self.assertEqual(child_kernel.parent_unique_id, parent_kernel.unique_id)
                parent.stdin.close()
                self.assertEqual(parent.wait(timeout=5), 0)
                retained = reader.identity(pid)
                self.assertEqual(retained, child_kernel)
                self.assertEqual(retained.parent_unique_id, parent_kernel.unique_id)
                self.assertNotEqual(psutil.Process(pid).ppid(), parent.pid)
                self.assertIn(pid, reader.same_uid_pids())
            finally:
                if parent.poll() is None:
                    parent.kill()
                parent.wait(timeout=5)
                if parent.stdin is not None and not parent.stdin.closed:
                    parent.stdin.close()
                if child_identity is not None and child_kernel is not None:
                    with suppress(psutil.Error):
                        current = psutil.Process(child_identity[0])
                        if (
                            current.create_time() == child_identity[1]
                            and reader.identity(current.pid) == child_kernel
                        ):
                            current.kill()
                            current.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
