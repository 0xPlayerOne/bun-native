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
    if mode == "renderer-exit":
        records[0]["rendererPid"] = 104
    if mode == "backend-hang":
        records = [
            {"event": "bunly.runtime.profile", "profile": "standard"},
            *records,
            {"event": "bunly.fault.blocked", "mode": mode, "pid": 101, "quitRequested": True},
        ]
    elif mode.startswith("backend-"):
        if mode == "backend-shell-tree-exit":
            records.extend(
                [
                    {
                        "event": "bunly.fault.descendant",
                        "pid": 102,
                        "parentPid": 101,
                        "role": "shell",
                    },
                    {
                        "event": "bunly.fault.descendant",
                        "pid": 103,
                        "parentPid": 102,
                        "role": "server",
                    },
                    {
                        "event": "bunly.fault.tree-observed",
                        "mode": mode,
                        "count": 2,
                        "serverResponded": True,
                    },
                ]
            )
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
        if mode == "renderer-exit":
            injections[0]["targetAuthority"] = "native-main-frame"
    for phase in PHASES:
        records.append({"event": "bunly.host.shutdown-phase", "phase": phase, "state": "start"})
        if phase == "process-stop":
            records.append(
                {
                    "event": "bunly.backend.exit",
                    "pid": 101,
                    "code": None
                    if mode == "backend-hang"
                    else 23
                    if mode.startswith("backend-")
                    else 0,
                    "forced": mode == "backend-hang",
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
                "durationMs": 2000 if mode == "backend-hang" and phase == "process-stop" else 1,
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
        "samples": [
            {
                "processes": [
                    {"pid": 102, "parentPid": 101, "creationTime": 1},
                    {"pid": 103, "parentPid": 102, "creationTime": 1},
                ]
            }
        ],
        "descendantIdentities": (
            [
                {"pid": 102, "parentPid": 101, "creationTime": 1},
                {"pid": 103, "parentPid": 102, "creationTime": 1},
            ]
            if mode == "backend-shell-tree-exit"
            else []
        ),
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


class ExtendedSupervisionTests(unittest.TestCase):
    def test_hung_backend_requires_forcing_after_the_original_grace_deadline(self):
        observation, injections = fixture("backend-hang")
        rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
        for event, field, value in (
            ("bunly.backend.exit", "forced", False),
            ("bunly.backend.exit", "code", 0),
            ("bunly.backend.exit", "code", True),
            ("bunly.fault.blocked", "quitRequested", False),
            ("bunly.runtime.profile", "profile", "unknown"),
            ("bunly.host.shutdown-phase", "durationMs", 1999),
        ):
            changed = copy.deepcopy(rows)
            for row in changed:
                if row["event"] == event and (
                    field != "durationMs"
                    or row.get("phase") == "process-stop"
                    and row.get("state") == "complete"
                ):
                    row[field] = value
            with self.subTest(event=event, field=field), self.assertRaises(ValueError):
                accept_fault(
                    "backend-hang",
                    {**observation, "nativeDiagnostics": [json.dumps(row) for row in changed]},
                    injections,
                )

    def test_shell_and_listening_grandchild_require_distinct_observed_ancestry(self):
        observation, injections = fixture("backend-shell-tree-exit")
        for samples in (
            [],
            [{"processes": [{"pid": 102, "parentPid": 101, "creationTime": 1}]}],
            [
                {
                    "processes": [
                        {"pid": 102, "parentPid": 101, "creationTime": 1},
                        {"pid": 103, "parentPid": 102, "creationTime": 9},
                    ]
                }
            ],
        ):
            with self.assertRaises(ValueError):
                accept_fault(
                    "backend-shell-tree-exit", {**observation, "samples": samples}, injections
                )
        for identities in (
            [],
            observation["descendantIdentities"] * 2,
            [
                {"pid": 102, "parentPid": 101, "creationTime": 1},
                {"pid": 103, "parentPid": 999, "creationTime": 1},
            ],
        ):
            with self.assertRaises(ValueError):
                accept_fault(
                    "backend-shell-tree-exit",
                    {**observation, "descendantIdentities": identities},
                    injections,
                )
        rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
        for row in rows:
            if row["event"] == "bunly.fault.tree-observed":
                row["serverResponded"] = False
        with self.assertRaises(ValueError):
            accept_fault(
                "backend-shell-tree-exit",
                {**observation, "nativeDiagnostics": [json.dumps(row) for row in rows]},
                injections,
            )


class RendererTargetAcceptanceTests(unittest.TestCase):
    def test_role_only_or_foreign_renderer_cannot_qualify_current_faults(self):
        observation, injections = fixture("renderer-exit")
        for pid in (105, 101, True, 0, 2**31):
            changed = copy.deepcopy(observation)
            rows = [json.loads(line) for line in changed["nativeDiagnostics"]]
            rows[0]["rendererPid"] = pid
            changed["nativeDiagnostics"] = [json.dumps(row) for row in rows]
            with self.subTest(pid=pid), self.assertRaises(ValueError):
                accept_fault("renderer-exit", changed, injections)
        for authority in (None, "renderer-role", True):
            changed = [{**injections[0], "targetAuthority": authority}]
            with self.assertRaises(ValueError):
                accept_fault("renderer-exit", observation, changed)

    def test_historical_renderer_role_claim_requires_explicit_legacy_selection(self):
        observation, injections = fixture("renderer-exit")
        rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
        del rows[0]["rendererPid"]
        observation["nativeDiagnostics"] = [json.dumps(row) for row in rows]
        del injections[0]["targetAuthority"]
        with self.assertRaises(ValueError):
            accept_fault("renderer-exit", observation, injections)
        accept_fault("renderer-exit", observation, injections, require_renderer_identity=False)


class NativeRendererTaskTests(unittest.TestCase):
    @staticmethod
    def task_fixture():
        observation, _ = fixture("renderer-exit")
        rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
        del rows[0]["rendererPid"]
        for row in rows:
            if row["event"] == "bunly.native.renderer-failure-observed":
                row.update({"exitCode": 86, "nativeErrorCode": 86 << 8, "platform": "darwin"})
        rows.insert(
            1,
            {
                "event": "bunly.native.renderer-injected",
                "schema": 1,
                "authority": "native-main-frame-message",
                "exitCode": 86,
            },
        )
        observation["nativeDiagnostics"] = [json.dumps(row) for row in rows]
        return observation

    def test_native_task_injection_requires_actual_failure_and_no_external_pid_signal(self):
        observation = self.task_fixture()
        result = accept_fault(
            "renderer-exit",
            observation,
            [],
            require_renderer_message=True,
            renderer_platform="darwin",
        )
        self.assertTrue(result["expectedApplicationFailure"])
        with self.assertRaises(ValueError):
            accept_fault("renderer-exit", observation, [])
        for injected in ([{"pid": 1}], [{"role": "renderer"}]):
            with self.assertRaises(ValueError):
                accept_fault(
                    "renderer-exit",
                    observation,
                    injected,
                    require_renderer_message=True,
                    renderer_platform="darwin",
                )
        old, injected = fixture("renderer-exit")
        with self.assertRaises(ValueError):
            accept_fault(
                "renderer-exit",
                old,
                injected,
                require_renderer_message=True,
                renderer_platform="darwin",
            )

    def test_missing_duplicate_wrong_or_reordered_native_injection_never_passes(self):
        observation = self.task_fixture()
        rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
        for key, value in (
            ("schema", 2),
            ("schema", True),
            ("exitCode", 0),
            ("exitCode", True),
            ("authority", "renderer-role"),
            ("pid", 1),
        ):
            changed = copy.deepcopy(rows)
            changed[1][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                accept_fault(
                    "renderer-exit",
                    {**observation, "nativeDiagnostics": [json.dumps(row) for row in changed]},
                    [],
                    require_renderer_message=True,
                    renderer_platform="darwin",
                )
        for changed in (
            rows[:1] + rows[2:],
            rows + [rows[1]],
            [rows[1], rows[0], *rows[2:]],
            [rows[0], *rows[2:], rows[1]],
        ):
            with self.assertRaises(ValueError):
                accept_fault(
                    "renderer-exit",
                    {**observation, "nativeDiagnostics": [json.dumps(row) for row in changed]},
                    [],
                    require_renderer_message=True,
                    renderer_platform="darwin",
                )

    def test_namespace_pid_is_not_reinterpreted_as_host_identity(self):
        observation = self.task_fixture()
        rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
        rows[0]["rendererPid"] = 1
        with self.assertRaises(ValueError):
            accept_fault(
                "renderer-exit",
                {**observation, "nativeDiagnostics": [json.dumps(row) for row in rows]},
                [],
                require_renderer_message=True,
                renderer_platform="darwin",
            )

    def test_missing_actual_renderer_failure_cannot_pass_a_successful_request_receipt(self):
        observation = self.task_fixture()
        for event in ("bunly.host.failure", "bunly.native.renderer-failure-observed"):
            altered = {
                **observation,
                "nativeDiagnostics": [
                    line
                    for line in observation["nativeDiagnostics"]
                    if json.loads(line)["event"] != event
                ],
            }
            with self.assertRaises(ValueError):
                accept_fault(
                    "renderer-exit",
                    altered,
                    [],
                    require_renderer_message=True,
                    renderer_platform="darwin",
                )

    def test_raw_native_status_must_match_independently_selected_platform(self):
        observation = self.task_fixture()
        accept_fault(
            "renderer-exit",
            observation,
            [],
            require_renderer_message=True,
            renderer_platform="darwin",
        )
        for platform in (None, "unknown", "win32", "linux"):
            with self.assertRaises(ValueError):
                accept_fault(
                    "renderer-exit",
                    observation,
                    [],
                    require_renderer_message=True,
                    renderer_platform=platform,
                )
        for platform in ("linux", "win32"):
            rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
            for row in rows:
                if row["event"] == "bunly.native.renderer-failure-observed":
                    row.update(
                        {
                            "platform": platform,
                            "nativeErrorCode": 86 if platform == "win32" else 22016,
                        }
                    )
            changed = {**observation, "nativeDiagnostics": [json.dumps(row) for row in rows]}
            accept_fault(
                "renderer-exit",
                changed,
                [],
                require_renderer_message=True,
                renderer_platform=platform,
            )
            for bad in (0, True, -1, 9, 11, "22016", 85 << 8, 87 << 8):
                altered = copy.deepcopy(rows)
                for row in altered:
                    if row["event"] == "bunly.native.renderer-failure-observed":
                        row["nativeErrorCode"] = bad
                with self.assertRaises(ValueError):
                    accept_fault(
                        "renderer-exit",
                        {**observation, "nativeDiagnostics": [json.dumps(row) for row in altered]},
                        [],
                        require_renderer_message=True,
                        renderer_platform=platform,
                    )


class NativeRendererHandshakeTests(unittest.TestCase):
    def test_current_renderer_fault_requires_failed_sdk_shutdown_and_backend_exit_one(self):
        observation = NativeRendererTaskTests.task_fixture()
        rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
        rows[1].update({"schema": 2, "authority": "native-main-frame-handshake"})
        for row in rows:
            if row["event"] == "bunly.backend.exit":
                row["code"] = 1
            if row["event"] == "bunly.native.renderer-failure-observed":
                row["shutdownRejected"] = True

        def accept(current):
            return accept_fault(
                "renderer-exit",
                {**observation, "nativeDiagnostics": [json.dumps(row) for row in current]},
                [],
                require_renderer_handshake=True,
                require_failed_shutdown=True,
                renderer_platform="darwin",
            )

        self.assertTrue(accept(rows)["expectedApplicationFailure"])
        for code in (0, 2, True, None):
            changed = copy.deepcopy(rows)
            for row in changed:
                if row["event"] == "bunly.backend.exit":
                    row["code"] = code
            with self.assertRaises(ValueError):
                accept(changed)
        for rejected in (False, 1, None, "true"):
            changed = copy.deepcopy(rows)
            for row in changed:
                if row["event"] == "bunly.native.renderer-failure-observed":
                    if rejected is None:
                        del row["shutdownRejected"]
                    else:
                        row["shutdownRejected"] = rejected
            with self.assertRaises(ValueError):
                accept(changed)
        for event in (
            "bunly.native.renderer-injected",
            "bunly.native.renderer-failure-observed",
            "bunly.host.failure",
            "bunly.native.output-drained",
        ):
            with self.assertRaises(ValueError):
                accept([row for row in rows if row["event"] != event])
        with self.assertRaises(ValueError):
            accept_fault(
                "renderer-exit",
                observation,
                [],
                require_failed_shutdown=True,
                renderer_platform="darwin",
            )

    def test_native_ack_and_commit_receipt_cannot_replace_the_actual_renderer_exit(self):
        observation = NativeRendererTaskTests.task_fixture()
        rows = [json.loads(line) for line in observation["nativeDiagnostics"]]
        rows[1].update({"schema": 2, "authority": "native-main-frame-handshake"})
        correct = {**observation, "nativeDiagnostics": [json.dumps(row) for row in rows]}
        accept_fault(
            "renderer-exit",
            correct,
            [],
            require_renderer_handshake=True,
            renderer_platform="darwin",
        )
        with self.assertRaises(ValueError):
            accept_fault(
                "renderer-exit",
                correct,
                [],
                require_renderer_message=True,
                renderer_platform="darwin",
            )
        with self.assertRaises(ValueError):
            accept_fault(
                "renderer-exit",
                observation,
                [],
                require_renderer_handshake=True,
                renderer_platform="darwin",
            )
        for event in (
            "bunly.native.renderer-injected",
            "bunly.native.renderer-failure-observed",
            "bunly.host.failure",
        ):
            changed = {
                **correct,
                "nativeDiagnostics": [json.dumps(row) for row in rows if row["event"] != event],
            }
            with self.assertRaises(ValueError):
                accept_fault(
                    "renderer-exit",
                    changed,
                    [],
                    require_renderer_handshake=True,
                    renderer_platform="darwin",
                )
        for key, value in (
            ("schema", True),
            ("schema", 1),
            ("authority", "native-main-frame-message"),
            ("exitCode", 0),
            ("exitCode", True),
            ("extra", 86),
        ):
            changed = copy.deepcopy(rows)
            changed[1][key] = value
            with self.assertRaises(ValueError):
                accept_fault(
                    "renderer-exit",
                    {**correct, "nativeDiagnostics": [json.dumps(row) for row in changed]},
                    [],
                    require_renderer_handshake=True,
                    renderer_platform="darwin",
                )
