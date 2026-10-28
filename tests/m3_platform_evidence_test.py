"""Parser tests and replay of preserved native evidence; no browser execution in this suite."""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from report_m3_platform import FAULTS, POSITIVES, REJECTIONS, isolation, validate, verify


def process(code, records):
    return {
        "exitCode": code,
        "timedOut": False,
        "cancelled": False,
        "outputOverflow": False,
        "observedOrphans": [],
        "cleanupSurvivors": [],
        "stdoutTail": [],
        "stderr": [json.dumps(r) for r in records],
        "samples": [],
    }


def fixture(target="linux-x64"):
    profile = "emulated-functional"
    rows = []
    for name in sorted(POSITIVES):
        records = [
            {
                "event": "bunly.native.smoke",
                "passed": True,
                "cycles": 20,
                "timers": 3,
                "diagnostics": {
                    "windows": 1,
                    "views": 1,
                    "sessions": 1,
                    "deadlineProfile": profile,
                },
            },
            {"event": "bunly.backend.exit", "code": 0, "forced": False},
            {"event": "bunly.host.shutdown", "clean": True},
        ]
        if name == "last-window":
            records.append({"event": "bunly.native.last-window", "passed": True})
        observation = process(0, records)
        native = (
            {
                "provider": "linux-proc-status-v1",
                "available": True,
                "isolationObserved": True,
                "seccompFilter": True,
                "noNewPrivileges": True,
                "effectiveCapabilitiesZero": True,
                "namespacePidDepth": 3,
            }
            if target == "linux-x64"
            else {
                "provider": "windows-token-job-v1",
                "available": True,
                "isolationObserved": True,
                "integrityRid": 0,
                "restrictedSids": True,
                "appContainer": False,
                "inJob": True,
            }
        )
        field = "linuxSandbox" if target == "linux-x64" else "windowsSandbox"
        observation["samples"] = [
            {
                "processes": [
                    {
                        "pid": 42,
                        "creationTime": 1234.5,
                        "browserRole": "zygote" if target == "linux-x64" else "renderer",
                        field: native,
                    }
                ]
            }
        ]
        rows.append({"name": name, "observation": observation})
    negative = dict(REJECTIONS)
    if target == "linux-x64":
        negative["missing-display"] = "requires an X11 DISPLAY"
    rows.extend(
        {"name": name, "observation": process(78, [{"event": "bunly.host.error", "error": text}])}
        for name, text in negative.items()
    )
    if target == "linux-x64":
        missing = process(127, [])
        missing["stderr"] = ["libcef.so: cannot open shared object file: No such file or directory"]
        rows.append({"name": "missing-cef-library", "observation": missing})
    faults = []
    for mode in sorted(FAULTS):
        records = [
            {"event": "bunly.fault.ready", "mode": mode},
            {"event": "bunly.host.shutdown", "clean": mode == "gpu-exit"},
        ]
        injected = []
        if mode.startswith("backend"):
            records.append({"event": "bunly.backend.exit", "code": 23, "forced": False})
        else:
            records.append(
                {
                    "event": "bunly.native.gpu-recovered"
                    if mode == "gpu-exit"
                    else "bunly.native.renderer-failure-observed",
                    "passed": True,
                }
            )
            injected = [
                {
                    "pid": 42,
                    "creationTime": 1234.5,
                    "role": "gpu-process" if mode == "gpu-exit" else "renderer",
                }
            ]
        if mode == "gpu-exit":
            records.append({"event": "bunly.native.gpu-injection-acknowledged", "passed": True})
        faults.append(
            {
                "mode": mode,
                "passed": True,
                "injected": injected,
                "observation": process(0 if mode == "gpu-exit" else 1, records),
            }
        )
    return {
        "prebuilt": {
            "target": target,
            "passed": True,
            "deadlineProfile": profile,
            "noCompilerPath": True,
            "sourceArtifactUnchanged": True,
            "trials": rows,
        },
        "development": {
            "target": target,
            "deadlineProfile": profile,
            "passed": True,
            "deniedRequests": 0,
            "observation": process(0, [{"event": "bunly.native.development", "passed": True}]),
        },
        "faults": {
            "platform": target.split("-")[0],
            "deadlineProfile": profile,
            "passed": True,
            "trials": faults,
        },
        "identity": {
            "source": "exported-api",
            "cefVersion": "154.0.34",
            "chromiumVersion": "154.0.8037.98",
            "sha256": "a" * 64,
        },
        "environment": {
            "target": target,
            "standardUser": True,
            "emulated": True,
            "bunVersion": "1.4.3",
        },
    }


def supervised_fixture(target="linux-x64", schema=4):
    from cef_fault_acceptance import MODES
    from cef_fault_acceptance_test import NativeRendererTaskTests
    from cef_fault_acceptance_test import fixture as fault_fixture

    report = fixture(target)
    trials = []
    for mode in MODES:
        observation, injections = fault_fixture(mode)
        if mode == "renderer-exit" and schema in (7, 8):
            observation = NativeRendererTaskTests.task_fixture()
            injections = []
        records = [json.loads(line) for line in observation["nativeDiagnostics"]]
        for row in records:
            if row["event"] == "bunly.runtime.profile":
                row["profile"] = "emulated-functional"
            if (
                mode == "backend-hang"
                and row["event"] == "bunly.host.shutdown-phase"
                and row.get("phase") == "process-stop"
                and row.get("state") == "complete"
            ):
                row["durationMs"] = 5000
            if mode == "renderer-exit" and schema in (7, 8):
                if row["event"] == "bunly.native.renderer-injected":
                    row.update(schema=2, authority="native-main-frame-handshake")
                elif row["event"] == "bunly.native.renderer-failure-observed":
                    row.update(
                        platform=target.split("-")[0],
                        nativeErrorCode=86 if target == "win32-x64" else 86 << 8,
                    )
                    if schema == 8:
                        row["shutdownRejected"] = True
                elif row["event"] == "bunly.backend.exit" and schema == 8:
                    row["code"] = 1
        observation["nativeDiagnostics"] = [json.dumps(row) for row in records]
        trials.append(
            {
                "mode": mode,
                "passed": True,
                "injected": injections,
                "observation": observation,
                "foreignControl": {
                    "pid": 909,
                    "creationTime": 1.25,
                    "ready": True,
                    "aliveAfterHostExit": True,
                    "releasedNormally": True,
                    "sameExecutableAsBackend": True,
                },
            }
        )
    report["faults"].update(schema=schema, trials=trials)
    return report


class PlatformEvidenceTests(unittest.TestCase):
    def test_complete_synthetic_plans_are_not_performance_or_hardware_claims(self):
        for target, count in [("linux-x64", 12), ("win32-x64", 10)]:
            result = validate(target, "emulated-functional", fixture(target))
            self.assertEqual(result["prebuiltTrials"], count)
            self.assertFalse(result["performanceQualified"])
            self.assertFalse(result["hardwareGpuQualified"])

    def test_missing_or_duplicate_trial_fails(self):
        for duplicate in (False, True):
            report = fixture()
            trial = report["prebuilt"]["trials"].pop()
            if duplicate:
                report["prebuilt"]["trials"].append(report["prebuilt"]["trials"][0])
            self.assertTrue(trial)
            with self.assertRaises(ValueError):
                validate("linux-x64", "emulated-functional", report)

    def test_wrong_profile_or_elevated_execution_fails(self):
        for key, value in [
            ("standardUser", False),
            ("emulated", False),
            ("bunVersion", "unverified"),
        ]:
            report = fixture()
            report["environment"][key] = value
            with self.assertRaises(ValueError):
                validate("linux-x64", "emulated-functional", report)
        with self.assertRaises(ValueError):
            validate("linux-x64", "standard", fixture())

    def test_absent_isolation_or_contradictory_native_fields_fail(self):
        report = fixture()
        observation = report["prebuilt"]["trials"][0]["observation"]
        for field, value in [
            ("seccompFilter", False),
            ("namespacePidDepth", 1),
            ("available", False),
        ]:
            changed = copy.deepcopy(observation)
            changed["samples"][0]["processes"][0]["linuxSandbox"][field] = value
            with self.assertRaises(ValueError):
                isolation(changed, "linux-x64")

    def test_timeouts_or_cleanup_survivors_fail(self):
        for field, value in [
            ("timedOut", True),
            ("cleanupSurvivors", [42]),
            ("observedOrphans", [42]),
        ]:
            report = fixture()
            report["prebuilt"]["trials"][0]["observation"][field] = value
            with self.assertRaises(ValueError):
                validate("linux-x64", "emulated-functional", report)

    def test_missed_fault_or_forbidden_request_cannot_pass(self):
        report = fixture()
        report["faults"]["trials"].pop()
        with self.assertRaises(ValueError):
            validate("linux-x64", "emulated-functional", report)
        report = fixture()
        report["development"]["deniedRequests"] = 1
        with self.assertRaises(ValueError):
            validate("linux-x64", "emulated-functional", report)

    def test_gpu_recovery_requires_actual_injection_acknowledgement(self):
        report = fixture()
        trial = next(t for t in report["faults"]["trials"] if t["mode"] == "gpu-exit")
        trial["observation"]["stderr"] = [
            line
            for line in trial["observation"]["stderr"]
            if "bunly.native.gpu-injection-acknowledged" not in line
        ]
        with self.assertRaisesRegex(ValueError, "actual GPU injection"):
            validate("linux-x64", "emulated-functional", report)

    def test_wrong_native_engine_version_cannot_inherit_passing_results(self):
        report = fixture()
        report["identity"]["chromiumVersion"] = "154.0.0.0"
        with self.assertRaisesRegex(ValueError, "actual CEF identity"):
            validate("linux-x64", "emulated-functional", report)

    def test_current_engine_requires_an_explicit_pin_without_relabeling_old_evidence(self):
        old = fixture()
        current = fixture()
        current["identity"].update(cefVersion="156.0.7", chromiumVersion="156.0.8078.17")
        self.assertTrue(validate("linux-x64", "emulated-functional", old)["passed"])
        self.assertTrue(
            validate(
                "linux-x64",
                "emulated-functional",
                current,
                expected_identity=("156.0.7", "156.0.8078.17"),
            )["passed"]
        )
        with self.assertRaisesRegex(ValueError, "actual CEF identity"):
            validate("linux-x64", "emulated-functional", current)
        with self.assertRaisesRegex(ValueError, "actual CEF identity"):
            validate(
                "linux-x64",
                "emulated-functional",
                old,
                expected_identity=("156.0.7", "156.0.8078.17"),
            )

    def test_current_supervision_requires_six_cases_and_an_independent_control(self):
        report = supervised_fixture()
        self.assertEqual(validate("linux-x64", "emulated-functional", report)["faultCases"], 6)
        missing = copy.deepcopy(report)
        missing["faults"]["trials"].pop()
        with self.assertRaises(ValueError):
            validate("linux-x64", "emulated-functional", missing)
        missing = copy.deepcopy(report)
        missing["faults"]["trials"][0].pop("foreignControl")
        with self.assertRaises(ValueError):
            validate("linux-x64", "emulated-functional", missing)

    def test_failed_shutdown_schema_preserves_current_and_historical_aggregate_contracts(self):
        for target in ("linux-x64", "win32-x64"):
            for schema in (7, 8):
                report = supervised_fixture(target, schema)
                with self.subTest(target=target, schema=schema):
                    self.assertEqual(
                        validate(target, "emulated-functional", report)["faultCases"], 6
                    )
                report["faults"]["schema"] = 8 if schema == 7 else 7
                with self.assertRaises(ValueError):
                    validate(target, "emulated-functional", report)

            for field, value in (
                ("code", 0),
                ("code", 2),
                ("code", True),
                ("shutdownRejected", False),
                ("shutdownRejected", 1),
                ("shutdownRejected", None),
            ):
                report = supervised_fixture(target, 8)
                trial = next(t for t in report["faults"]["trials"] if t["mode"] == "renderer-exit")
                rows = [json.loads(line) for line in trial["observation"]["nativeDiagnostics"]]
                event = (
                    "bunly.backend.exit"
                    if field == "code"
                    else "bunly.native.renderer-failure-observed"
                )
                row = next(row for row in rows if row["event"] == event)
                if value is None:
                    del row[field]
                else:
                    row[field] = value
                trial["observation"]["nativeDiagnostics"] = [json.dumps(row) for row in rows]
                with (
                    self.subTest(target=target, field=field, value=value),
                    self.assertRaises(ValueError),
                ):
                    validate(target, "emulated-functional", report)

    def test_unknown_fault_schema_cannot_fall_back_to_legacy_acceptance(self):
        for schema in (0, 9, True, "8"):
            report = fixture()
            report["faults"]["schema"] = schema
            with self.assertRaisesRegex(ValueError, "fault evidence schema"):
                validate("linux-x64", "emulated-functional", report)

    def test_preserved_linux_reports_reproduce_the_declared_summary(self):
        # Replays real historical records; this test does not launch a browser.
        directory = Path(__file__).resolve().parents[1] / "evidence/m3-linux"
        self.assertEqual(verify(directory), json.loads((directory / "summary.json").read_text()))

    def test_preserved_windows_reports_reproduce_the_declared_summary(self):
        # Replays real hosted Windows results; never substitutes for executing Windows.
        directory = Path(__file__).resolve().parents[1] / "evidence/m3-windows"
        result = verify(directory)
        self.assertEqual(result, json.loads((directory / "summary.json").read_text()))
        self.assertEqual(result["deadlineProfile"], "standard")
        self.assertEqual(result["prebuiltTrials"], 10)
        self.assertEqual(result["faultCases"], 4)
        self.assertFalse(result["performanceQualified"])


if __name__ == "__main__":
    unittest.main()
