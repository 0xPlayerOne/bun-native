"""Synthetic receipt regressions; actual fault injection is a separate platform gate."""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from cef_fault_acceptance import MODES, PHASES, accept_fault


def fixture(mode):
    records = [{"event": "bunly.fault.ready", "mode": mode, "pid": 101}]
    injections = []
    if mode.startswith("backend-"):
        if mode == "backend-tree-exit":
            records.append({"event": "bunly.fault.descendant", "pid": 102})
        records.append(
            {
                "event": "bunly.host.failure",
                "error": "Bun backend process exited before native shutdown",
            }
        )
    elif mode == "renderer-exit":
        records += [
            {
                "event": "bunly.host.failure",
                "error": "Renderer process terminated before native shutdown",
            },
            {"event": "bunly.native.renderer-failure-observed", "passed": True},
        ]
    else:
        records += [
            {"event": "bunly.native.gpu-injection-acknowledged", "passed": True},
            {"event": "bunly.native.gpu-recovered", "passed": True},
        ]
    if not mode.startswith("backend-"):
        role = "renderer" if mode == "renderer-exit" else "gpu-process"
        injections = [{"pid": 104, "creationTime": 1, "role": role, "roleEvidence": {"role": role}}]
    for phase in PHASES:
        records.append({"event": "bunly.host.shutdown-phase", "phase": phase, "state": "start"})
        if phase == "process-stop":
            records.append(
                {
                    "event": "bunly.backend.exit",
                    "pid": 101,
                    "code": 23 if mode.startswith("backend-") else 0,
                    "forced": False,
                }
            )
        if phase == "process-stop":
            records.append(
                {
                    "event": "bunly.native.output-drained",
                    "schema": 1,
                    "frames": 0,
                    "ordinaryFrames": 0,
                    "retainedWireBytes": 0,
                    "ordinaryWireBytes": 0,
                }
            )
        records.append(
            {
                "event": "bunly.host.shutdown-phase",
                "phase": phase,
                "state": "complete",
                "durationMs": 1,
            }
        )
    records.append({"event": "bunly.host.shutdown", "clean": mode == "gpu-exit"})
    return {
        "exitCode": 0 if mode == "gpu-exit" else 1,
        "timedOut": False,
        "cancelled": False,
        "outputOverflow": False,
        "observerFailure": None,
        "observedOrphans": [],
        "cleanupSurvivors": [],
        "stderr": ["ordinary log noise"] * 20,
        "samples": [{"processes": [{"pid": 102, "creationTime": 1}]}],
        "nativeDiagnostics": [json.dumps(row) for row in records],
    }, injections


class NativeFaultAcceptanceTests(unittest.TestCase):
    def test_exact_expected_failures_and_recovery_are_accepted_without_stderr_tail(self):
        for mode in MODES:
            observation, injections = fixture(mode)
            result = accept_fault(mode, observation, injections)
            self.assertTrue(result["orderedShutdown"])
            self.assertEqual(result["expectedApplicationFailure"], mode != "gpu-exit")

    def test_missing_duplicate_or_reordered_receipts_cannot_pass(self):
        for mode in MODES:
            observation, injections = fixture(mode)
            records = observation["nativeDiagnostics"]
            for index in range(len(records)):
                for replacement in (
                    records[:index] + records[index + 1 :],
                    records + [records[index]],
                ):
                    with self.subTest(mode=mode, index=index, count=len(replacement)):
                        altered = {**observation, "nativeDiagnostics": replacement}
                        with self.assertRaises(ValueError):
                            accept_fault(mode, altered, injections)
            with self.assertRaises(ValueError):
                accept_fault(
                    mode, {**observation, "nativeDiagnostics": list(reversed(records))}, injections
                )

    def test_simultaneous_observer_shutdown_and_helper_failures_are_not_masked(self):
        for mode in MODES:
            observation, injections = fixture(mode)
            for key, value in (
                ("timedOut", True),
                ("cancelled", True),
                ("outputOverflow", True),
                ("observedOrphans", [111]),
                ("cleanupSurvivors", [111]),
                ("observerFailure", "unavailable"),
                ("postExitCleanup", {"passed": False}),
                ("exitCode", 2),
                ("nativeDiagnostics", []),
                ("nativeDiagnostics", None),
            ):
                with self.subTest(mode=mode, field=key), self.assertRaises(ValueError):
                    accept_fault(mode, {**observation, key: value}, injections)

    def test_wrong_backend_identity_forced_exit_duration_and_failure_classification_deny(self):
        observation, injections = fixture("backend-exit")
        rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
        for event, field, value in (
            ("bunly.backend.exit", "code", 0),
            ("bunly.backend.exit", "pid", 999),
            ("bunly.backend.exit", "forced", True),
            ("bunly.host.shutdown", "clean", True),
            ("bunly.fault.ready", "mode", "renderer-exit"),
            ("bunly.host.failure", "error", "Unrelated native failure"),
            ("bunly.host.shutdown-phase", "durationMs", float("nan")),
        ):
            changed = copy.deepcopy(rows)
            for row in changed:
                if row["event"] == event and (
                    field != "durationMs" or row.get("state") == "complete"
                ):
                    row[field] = value
            with self.subTest(event=event, field=field), self.assertRaises(ValueError):
                accept_fault(
                    "backend-exit",
                    {**observation, "nativeDiagnostics": [json.dumps(row) for row in changed]},
                    injections,
                )

    def test_injection_identity_and_descendant_observation_are_required(self):
        for mode in ("renderer-exit", "gpu-exit"):
            observation, injections = fixture(mode)
            for value in (
                [],
                injections * 2,
                [{**injections[0], "role": "foreign"}],
                [{**injections[0], "creationTime": 0}],
            ):
                with self.assertRaises(ValueError):
                    accept_fault(mode, observation, value)
        observation, injections = fixture("backend-tree-exit")
        with self.assertRaises(ValueError):
            accept_fault("backend-tree-exit", {**observation, "samples": []}, injections)

    def test_complete_stream_is_authoritative_without_success_tail_fallback(self):
        observation, injections = fixture("gpu-exit")
        observation["stderr"] = observation["nativeDiagnostics"]
        observation["nativeDiagnostics"] = []
        with self.assertRaises(ValueError):
            accept_fault("gpu-exit", observation, injections)


class NativeOutputFaultTests(unittest.TestCase):
    def test_drain_is_required_zero_and_old_schema_requires_explicit_legacy_selection(self):
        for mode in MODES:
            observation, injections = fixture(mode)
            rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
            absent = {
                **observation,
                "nativeDiagnostics": [
                    json.dumps(row) for row in rows if row["event"] != "bunly.native.output-drained"
                ],
            }
            with self.assertRaises(ValueError):
                accept_fault(mode, absent, injections)
            accept_fault(mode, absent, injections, require_output=False)
            for field in ("frames", "ordinaryFrames", "retainedWireBytes", "ordinaryWireBytes"):
                for value in (1, -1, False, "0", None):
                    changed = copy.deepcopy(rows)
                    for row in changed:
                        if row["event"] == "bunly.native.output-drained":
                            row[field] = value
                    with (
                        self.subTest(mode=mode, field=field, value=value),
                        self.assertRaises(ValueError),
                    ):
                        accept_fault(
                            mode,
                            {
                                **observation,
                                "nativeDiagnostics": [json.dumps(row) for row in changed],
                            },
                            injections,
                        )
