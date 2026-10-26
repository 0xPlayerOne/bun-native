"""Independent negative-control acceptance, not fabricated process execution."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from cef_fault_control import (
    accept_foreign_control,
    fault_readiness,
    fault_target_matches,
    notify_tree_observation,
)


class ForeignControlAcceptanceTests(unittest.TestCase):
    def test_ready_independent_survivor_is_required(self):
        control = {
            "pid": 100,
            "creationTime": 1.25,
            "ready": True,
            "aliveAfterHostExit": True,
            "releasedNormally": True,
            "sameExecutableAsBackend": True,
        }
        observation = {"samples": [{"processes": [{"pid": 101}]}]}
        accept_foreign_control(control, observation)
        for field in ("ready", "aliveAfterHostExit", "releasedNormally", "sameExecutableAsBackend"):
            for value in (False, None, 1, "true"):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    accept_foreign_control({**control, field: value}, observation)
        for field in control:
            with self.assertRaises(ValueError):
                accept_foreign_control(
                    {key: value for key, value in control.items() if key != field}, observation
                )
        with self.assertRaises(ValueError):
            accept_foreign_control(control, {"samples": [{"processes": [{"pid": 100}]}]})

    def test_malformed_identity_and_unknown_metadata_are_not_accepted(self):
        control = {
            "pid": 100,
            "creationTime": 1.25,
            "ready": True,
            "aliveAfterHostExit": True,
            "releasedNormally": True,
            "sameExecutableAsBackend": True,
        }
        for field, value in (
            ("pid", 0),
            ("pid", True),
            ("pid", "100"),
            ("creationTime", 0),
            ("creationTime", float("nan")),
            ("creationTime", float("inf")),
            ("creationTime", True),
            ("extra", True),
        ):
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                accept_foreign_control({**control, field: value}, {"samples": []})


class TreeNotificationTests(unittest.TestCase):
    @patch("cef_fault_control.http.client.HTTPConnection")
    def test_one_exact_loopback_publication_and_owned_cleanup(self, factory):
        connection = factory.return_value
        connection.getresponse.return_value = Mock(status=204)
        connection.getresponse.return_value.read.return_value = b""
        notify_tree_observation(12345, "a" * 48, [101, 102])
        factory.assert_called_once_with("127.0.0.1", 12345, timeout=1)
        connection.request.assert_called_once()
        args, kwargs = connection.request.call_args
        self.assertEqual(args, ("POST", "/observed"))
        self.assertEqual(
            json.loads(kwargs["body"]),
            {"mode": "backend-shell-tree-exit", "nonce": "a" * 48, "pids": [101, 102]},
        )
        connection.close.assert_called_once()

    @patch("cef_fault_control.http.client.HTTPConnection")
    def test_bad_identity_never_opens_a_socket(self, factory):
        for port, nonce, pids in (
            (True, "a" * 48, [101, 102]),
            (0, "a" * 48, [101, 102]),
            (65536, "a" * 48, [101, 102]),
            (123, "bad", [101, 102]),
            (123, "a" * 48, [101, 101]),
            (123, "a" * 48, [True, 102]),
        ):
            with self.assertRaises(ValueError):
                notify_tree_observation(port, nonce, pids)
        factory.assert_not_called()

    @patch("cef_fault_control.http.client.HTTPConnection")
    def test_failed_or_wrong_acknowledgment_is_not_retried(self, factory):
        for status, body in ((403, b""), (200, b""), (204, b"x")):
            connection = Mock()
            factory.return_value = connection
            connection.getresponse.return_value = Mock(status=status)
            connection.getresponse.return_value.read.return_value = body
            with self.assertRaises(ValueError):
                notify_tree_observation(123, "a" * 48, [101, 102])
            connection.request.assert_called_once()
            connection.close.assert_called_once()
        connection = Mock()
        connection.request.side_effect = OSError("unavailable")
        factory.return_value = connection
        with self.assertRaises(OSError):
            notify_tree_observation(123, "a" * 48, [101, 102])
        connection.request.assert_called_once()
        connection.close.assert_called_once()


class FaultRendererReadinessTests(unittest.TestCase):
    def test_exact_native_pid_selects_one_renderer_not_another_same_role_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ready.json"
            record = {"mode": "renderer-exit", "nonce": "a" * 48, "pid": 101, "rendererPid": 202}
            path.write_text(json.dumps(record))
            ready = fault_readiness(path, "a" * 48, "renderer-exit")
            self.assertEqual(ready, record)
            self.assertTrue(fault_target_matches(ready, "renderer-exit", 202))
            self.assertFalse(fault_target_matches(ready, "renderer-exit", 203))
            self.assertFalse(fault_target_matches(ready, "renderer-exit", 101))
            self.assertFalse(fault_target_matches(None, "renderer-exit", 202))

    def test_malformed_missing_or_duplicate_process_proof_is_not_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ready.json"
            record = {"mode": "renderer-exit", "nonce": "a" * 48, "pid": 101, "rendererPid": 202}
            for changed in [
                {key: value for key, value in record.items() if key != "rendererPid"},
                *[{**record, "rendererPid": value} for value in (True, "202", 0, 101, 2**31)],
                {**record, "nonce": "b" * 48},
                {**record, "extra": True},
                {**record, "mode": "gpu-exit"},
            ]:
                path.write_text(json.dumps(changed))
                self.assertIsNone(fault_readiness(path, "a" * 48, "renderer-exit"))
            path.write_text(json.dumps(record)[:-1] + ', "rendererPid":202}')
            self.assertIsNone(fault_readiness(path, "a" * 48, "renderer-exit"))
            path.write_text("x" * 4097)
            self.assertIsNone(fault_readiness(path, "a" * 48, "renderer-exit"))

    def test_gpu_mode_retains_its_separate_owned_role_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ready.json"
            record = {"mode": "gpu-exit", "nonce": "a" * 48, "pid": 101}
            path.write_text(json.dumps(record))
            ready = fault_readiness(path, "a" * 48, "gpu-exit")
            self.assertEqual(ready, record)
            self.assertTrue(fault_target_matches(ready, "gpu-exit", 303))
            self.assertFalse(fault_target_matches(ready, "backend-exit", 303))
