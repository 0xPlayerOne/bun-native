"""Pure host-control guards for the Windows native fault driver (#247)."""

import importlib.util
import re
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_fault_windows", ROOT / "scripts/quality/native-fault-windows.py"
)
FAULT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FAULT)

HOST = {"pid": 42, "created": "1000", "image": "C:\\host\\bun-native-gpui.exe"}


def driver(identity=None):
    fake = mock.Mock()
    fake.host = {"handle": 7, **HOST}
    fake.kernel.OpenProcess.return_value = 99
    fake._identity.return_value = dict(identity or HOST)
    return fake


class WindowsFaultControlTests(unittest.TestCase):
    def test_the_fixture_expects_the_code_the_driver_injects(self):
        source = (ROOT / "tests/native/fault.ts").read_text(encoding="utf-8")
        match = re.search(r"WINDOWS_FAULT_EXIT_CODE = (0x[0-9a-f]+)", source)
        self.assertIsNotNone(match)
        self.assertEqual(int(match.group(1), 16), FAULT.FAULT_EXIT_CODE)

    def test_control_opens_the_verified_host_with_only_the_rights_it_needs(self):
        fake = driver()
        control = FAULT.HostControl(fake)
        fake.kernel.OpenProcess.assert_called_once_with(
            FAULT.PROCESS_TERMINATE
            | FAULT.PROCESS_SUSPEND_RESUME
            | FAULT.PROCESS_QUERY_LIMITED_INFORMATION
            | FAULT.SYNCHRONIZE,
            False,
            42,
        )
        fake._identity.assert_called_once_with(99, 42)
        self.assertEqual(control.verify(), HOST)

    def test_a_reused_pid_is_refused_and_its_handle_released(self):
        fake = driver({**HOST, "created": "2000"})
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            FAULT.HostControl(fake)
        fake.kernel.CloseHandle.assert_called_once_with(99)
        fake.kernel.TerminateProcess.assert_not_called()

    def test_identity_is_rechecked_before_each_action(self):
        fake = driver()
        control = FAULT.HostControl(fake)
        fake._identity.return_value = {**HOST, "image": "C:\\other.exe"}
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            control.verify()

    def test_exit_code_zero_is_an_exit_not_a_running_host(self):
        fake = driver()
        control = FAULT.HostControl(fake)
        fake.kernel.WaitForSingleObject.return_value = FAULT.WAIT_TIMEOUT
        self.assertIsNone(control.exited())
        fake.kernel.WaitForSingleObject.return_value = FAULT.WAIT_OBJECT_0
        fake.kernel.GetExitCodeProcess.side_effect = lambda _handle, code: (
            setattr(code._obj, "value", 0) or True
        )
        self.assertEqual(control.exited(), {"code": 0})


if __name__ == "__main__":
    unittest.main()
