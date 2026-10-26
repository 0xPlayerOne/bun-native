"""Pure platform collector checks. Fixture records do not replace native acceptance."""

import ctypes
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sandbox = importlib.import_module("linux_sandbox")
parse_status, presence = sandbox.parse_status, sandbox.presence

spec = importlib.util.spec_from_file_location("cef_faults", ROOT / "scripts/qualify-cef-faults.py")
faults = importlib.util.module_from_spec(spec)
spec.loader.exec_module(faults)

STATUS = "Seccomp: 2\nNoNewPrivs: 1\nCapEff: 0000000000000000\nNSpid: 400 2\n"


class LinuxSandboxTests(unittest.TestCase):
    def test_isolation_requires_all_fields(self):
        self.assertTrue(parse_status(STATUS)["isolationObserved"])
        for before, after in [
            ("Seccomp: 2", "Seccomp: 0"),
            ("NoNewPrivs: 1", "NoNewPrivs: 0"),
            ("0000000000000000", "0000000000000001"),
            ("400 2", "400"),
        ]:
            self.assertFalse(parse_status(STATUS.replace(before, after))["isolationObserved"])

    def test_missing_duplicate_invalid_is_never_zero(self):
        for text in [
            "",
            STATUS + "Seccomp: 2\n",
            STATUS.replace("Seccomp: 2", "Seccomp: 9"),
            STATUS.replace("400 2", "-1 2"),
            STATUS.replace("0000000000000000", "garbage"),
        ]:
            with self.assertRaises(ValueError):
                parse_status(text)

    def test_invalid_pid_rejected_before_read(self):
        for pid in [True, -1, 0, 2**31, "12"]:
            with self.assertRaises(ValueError):
                presence(pid)


class WindowsSandboxTests(unittest.TestCase):
    def test_requires_token_restriction_integrity_and_job(self):
        module = importlib.import_module("windows_sandbox")
        self.assertTrue(module.classify(0x1000, True, False, True)["isolationObserved"])
        self.assertTrue(module.classify(0, False, True, True)["isolationObserved"])
        for args in [
            (0x2000, True, True, True),
            (0x1000, False, False, True),
            (0, True, False, False),
        ]:
            self.assertFalse(module.classify(*args)["isolationObserved"])
        for rid in [True, -1, 65536]:
            with self.assertRaises(ValueError):
                module.classify(rid, True, True, True)

    def test_sid_buffer_bounds_and_mandatory_authority(self):
        module = importlib.import_module("windows_sandbox")
        size = ctypes.sizeof(module.Label)
        data = ctypes.create_string_buffer(size + 12)
        label = module.Label.from_buffer(data)
        label.sid = ctypes.addressof(data) + size
        sid = bytes([1, 1, 0, 0, 0, 0, 0, 16, 0, 16, 0, 0])
        ctypes.memmove(label.sid, sid, 12)
        self.assertEqual(module.integrity_rid(data, size + 12), 0x1000)
        with self.assertRaises(ValueError):
            module.integrity_rid(data, size + 8)
        label.sid = ctypes.addressof(data) - 1
        with self.assertRaises(ValueError):
            module.integrity_rid(data, size + 12)
        label.sid = ctypes.addressof(data) + size
        ctypes.memmove(label.sid, bytes([1, 1, 0, 0, 0, 0, 0, 5]) + sid[8:], 12)
        with self.assertRaises(ValueError):
            module.integrity_rid(data, size + 12)

    def test_missing_windows_provider_is_unknown_not_passing(self):
        module = importlib.import_module("windows_sandbox")
        if sys.platform != "win32":
            self.assertIsNone(module.presence(123)["isolationObserved"])
        for pid in [True, 0, -1, "1"]:
            with self.assertRaises(ValueError):
                module.presence(pid)


class FaultReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "ready.json"
        self.nonce = "a" * 48

    def tearDown(self):
        self.temporary.cleanup()

    def test_missing_marker_does_not_trigger_a_timed_guess(self):
        self.assertFalse(faults.fault_readiness(self.path, self.nonce, "renderer-exit"))

    def test_only_matching_complete_page_marker_is_accepted(self):
        self.path.write_text(
            json.dumps(
                {"nonce": self.nonce, "mode": "renderer-exit", "pid": 123, "rendererPid": 456}
            )
        )
        self.assertTrue(faults.fault_readiness(self.path, self.nonce, "renderer-exit"))
        self.assertFalse(faults.fault_readiness(self.path, "b" * 48, "renderer-exit"))
        self.assertFalse(faults.fault_readiness(self.path, self.nonce, "gpu-exit"))

    def test_malformed_oversized_and_linked_markers_rejected(self):
        for value in [
            "{",
            "x" * 4097,
            json.dumps({"nonce": self.nonce, "mode": "renderer-exit", "pid": True}),
            "[]",
        ]:
            self.path.write_text(value)
            self.assertFalse(faults.fault_readiness(self.path, self.nonce, "renderer-exit"))
        self.path.unlink()
        self.path.symlink_to("missing")
        self.assertFalse(faults.fault_readiness(self.path, self.nonce, "renderer-exit"))


if __name__ == "__main__":
    unittest.main()
