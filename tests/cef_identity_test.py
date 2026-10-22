"""Pure inspector tests; mocked loaders never stand in for browser qualification."""

import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "cef_identity", ROOT / "scripts/probe_cef_identity.py"
)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "test-library"
        self.path.write_bytes(b"test-only-placeholder")
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.parts = [123, 4, 5, 6, 123, 0, 4567, 89]

    def tearDown(self):
        self.tmp.cleanup()

    def library(self, full=None):
        result = SimpleNamespace(cef_version_info=lambda index: self.parts[index])
        if full is not None:
            result.cef_version_full = lambda: full
        return result

    def test_old_and_new_public_abi(self):
        for full in (None, b"123.4.5+g123abcd+chromium-123.0.4567.89"):
            with patch.object(module.ctypes, "CDLL", return_value=self.library(full)):
                value = module.inspect(self.path, self.digest)
                self.assertEqual(value["chromiumVersion"], "123.0.4567.89")
                self.assertEqual(value["sandbox"], "unverified")
                self.assertEqual(value["fullVersion"], None if full is None else full.decode())

    def test_wrong_hash_never_loads_native_code(self):
        with patch.object(module.ctypes, "CDLL") as loader:
            with self.assertRaises(ValueError):
                module.inspect(self.path, "0" * 64)
            loader.assert_not_called()

    def test_missing_export(self):
        with (
            patch.object(module.ctypes, "CDLL", return_value=SimpleNamespace()),
            self.assertRaises(AttributeError),
        ):
            module.inspect(self.path, self.digest)

    def test_negative_component(self):
        self.parts[7] = -1
        with (
            patch.object(module.ctypes, "CDLL", return_value=self.library()),
            self.assertRaises(ValueError),
        ):
            module.inspect(self.path, self.digest)

    def test_zero_major(self):
        self.parts[4] = 0
        with (
            patch.object(module.ctypes, "CDLL", return_value=self.library()),
            self.assertRaises(ValueError),
        ):
            module.inspect(self.path, self.digest)

    def test_link_is_rejected(self):
        link = self.path.with_name("link")
        link.symlink_to(self.path)
        with self.assertRaises(ValueError):
            module.verified_library(link, self.digest)

    def test_modified_file_after_native_call(self):
        def version(index):
            if index == 0:
                self.path.write_bytes(b"changed")
            return self.parts[index]

        with (
            patch.object(
                module.ctypes, "CDLL", return_value=SimpleNamespace(cef_version_info=version)
            ),
            self.assertRaises(ValueError),
        ):
            module.inspect(self.path, self.digest)

    def test_invalid_full_version(self):
        for full in (b"unsafe\ntext", b"x" * 257):
            with (
                patch.object(module.ctypes, "CDLL", return_value=self.library(full)),
                self.assertRaises(ValueError),
            ):
                module.inspect(self.path, self.digest)


if __name__ == "__main__":
    unittest.main()
