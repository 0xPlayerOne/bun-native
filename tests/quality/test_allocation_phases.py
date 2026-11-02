"""Fixed-region patch/attestation guards and actual owned-process cleanup."""

from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "allocation_phases", ROOT / "benchmarks/allocation-phases.py"
)
PHASES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PHASES)
CONTROL = PHASES.load(
    "allocation_control", ROOT / "benchmarks/native-allocation-control.py"
)


class PatchTests(unittest.TestCase):
    def setUp(self):
        # Minimal source fixture exposes the critical actual boundaries. It is
        # never compiled and cannot qualify either historical host.
        self.files = {
            "native/gpui-host/src/main.rs": (
                "mod channel;\nfn main() {\n    app.run(|cx| {\n        });\n}\n"
            ),
            "native/gpui-host/src/session.rs": (
                "        let prepared = state\n"
                "            .borrow()\n"
                "            .tree\n"
                "            .prepare(base_revision, operations, self.last_node_id);\n"
                "        let result = handle.update(cx, |view, window, cx| view.apply(prepared.tree, window, cx));\n"
                "        self.events.send(Event::Applied { id });\n"
            ),
            "native/gpui-host/src/view.rs": (
                "    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {\n"
                "        native_tree()\n    }\n"
            ),
        }

    def test_region_ends_inside_update_before_reply_and_preserves_original(self):
        original = deepcopy(self.files)
        patched = PHASES.patch_sources(self.files, "// adapter fixture\n")
        self.assertEqual(self.files, original)
        self.assertEqual(set(patched), PHASES.MODIFIED)
        session = patched["native/gpui-host/src/session.rs"]
        self.assertLess(session.index("allocation::before"), session.index(".prepare("))
        self.assertIn(
            "view.apply(prepared.tree, window, cx);\n"
            "            #[cfg(bun_native_allocation_diagnostic)]\n"
            "            crate::allocation::after(id, true);\n"
            "        });",
            session,
        )
        self.assertLess(
            session.index("allocation::after"), session.index("events.send")
        )
        self.assertIn("if result.is_err()", session)
        self.assertEqual(
            patched["native/gpui-host/src/view.rs"].count("allocation::render"), 1
        )

    def test_changed_or_duplicate_source_boundary_fails_before_any_write(self):
        for old, new in [
            ("mod channel;", "mod renamed_channel;"),
            ("mod channel;", "mod channel;\nmod channel;"),
        ]:
            files = deepcopy(self.files)
            files["native/gpui-host/src/main.rs"] = files[
                "native/gpui-host/src/main.rs"
            ].replace(old, new)
            with (
                self.subTest(new=new),
                self.assertRaisesRegex(ValueError, "anchor is missing or ambiguous"),
            ):
                PHASES.patch_sources(files, "")

    def test_flags_require_the_exact_existing_absolute_rlib(self):
        with tempfile.TemporaryDirectory() as temporary:
            rlib = Path(temporary) / "diagnostic.rlib"
            with self.assertRaisesRegex(ValueError, "exact diagnostic rlib"):
                PHASES.compiler_flags(rlib)
            rlib.write_bytes(b"inert fixture; never executed")
            flags = PHASES.compiler_flags(rlib)
            self.assertIn(f"bun_native_allocation_diagnostic={rlib}", flags)
            self.assertIn("cfg(bun_native_allocation_diagnostic)", flags)
            self.assertIn("--cfg", flags)
            self.assertIn("debuginfo=1", flags)
            with self.assertRaises(ValueError):
                PHASES.compiler_flags(Path("relative.rlib"))

    def test_failed_stale_or_changed_qualification_cannot_prepare_a_patch(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            rlib = directory / "diagnostic.rlib"
            rlib.write_bytes(b"inert artifact identity fixture")
            qualification = {
                "status": "passed",
                "sources": PHASES.diagnostic_sources(),
                "rlib": {"path": str(rlib), **PHASES.fingerprint(rlib)},
            }
            invalid = [
                ({**qualification, "status": "failed"}, "FFI control must pass"),
                ({**qualification, "sources": []}, "source changed after control"),
                (
                    {
                        **qualification,
                        "rlib": {**qualification["rlib"], "sha256": "0" * 64},
                    },
                    "Qualified rlib changed",
                ),
            ]
            for value, message in invalid:
                with (
                    self.subTest(message=message),
                    self.assertRaisesRegex(ValueError, message),
                ):
                    PHASES.prepare_patch(
                        directory / "unread-historical-source",
                        "bn1",
                        value,
                        directory / "patch",
                    )
                self.assertFalse((directory / "patch").exists())


class RegionTests(unittest.TestCase):
    def test_exact_control_frames_accept_v0_disambiguators_and_reject_lookalikes(self):
        selected = "selection_control[853722324872bafb]::selected_allocation (selection-control.rs)"
        self.assertEqual(
            CONTROL.allocation_stack_counts(
                f"main;{selected}; 1000\n"
                "selection_control::outside_region (selection-control.rs); 2\n"
                f"foreign_{selected}; 9\n"
                "selection_control[nothex]::selected_allocation (selection-control.rs); 7\n"
                "selection_control::selected_allocation (another.rs); 8\n"
            ),
            {"selected_allocation": 1000, "outside_region": 2},
        )
        # A recursive/repeated frame still denotes one allocation stack.
        self.assertEqual(
            CONTROL.allocation_stack_counts(f"{selected};{selected}; 1\n")[
                "selected_allocation"
            ],
            1,
        )
        for count in ("-1", "nan", "1e9", "１"):
            with (
                self.subTest(count=count),
                self.assertRaisesRegex(ValueError, "folded allocation count"),
            ):
                CONTROL.allocation_stack_counts(f"{selected}; {count}\n")

    def test_identity_fixed_interval_and_integer_counters_cannot_be_weakened(self):
        nonce, source, build, pid = "a" * 32, "b" * 40, "c" * 64, 123
        for phase, bounds in PHASES.PHASES.items():
            value = {
                "schemaVersion": 1,
                "status": "complete",
                "nonce": nonce,
                "source": source,
                "buildId": build,
                "pid": pid,
                "phase": phase,
                **bounds,
                "appliedCommands": bounds["lastRequest"] - bounds["firstRequest"] + 1,
                "rootRenderEntries": 0,
                "otherWindowRenderEntries": 2,
                "intervalNanoseconds": 100,
                "scope": "whole-native-process-allocations-during-selected-interval",
            }
            PHASES.validate_region(value, phase, nonce, source, build, pid)
            replacements = [
                ("schemaVersion", True),
                ("pid", pid + 1),
                ("nonce", "d" * 32),
                ("source", "d" * 40),
                ("buildId", "d" * 64),
                ("status", "failed"),
                ("firstRequest", bounds["firstRequest"] + 1),
                ("operationsPerCommand", True),
                ("appliedCommands", value["appliedCommands"] - 1),
                ("rootRenderEntries", False),
                ("otherWindowRenderEntries", -1),
                ("intervalNanoseconds", None),
                ("intervalNanoseconds", float("inf")),
                ("scope", "selected-thread-allocations"),
            ]
            for key, replacement in replacements:
                with self.subTest(phase=phase, key=key), self.assertRaises(ValueError):
                    PHASES.validate_region(
                        {**value, key: replacement}, phase, nonce, source, build, pid
                    )


@unittest.skipUnless(
    sys.platform == "linux" and PHASES.PAIRS.DRIVER.proc_identity_matches(),
    "Linux process IDs and /proc must share a PID namespace",
)
class ObservationCleanupTests(unittest.TestCase):
    def test_observer_rejection_cleans_the_actual_owned_child(self):
        PHASES.PAIRS.DRIVER.enable_subreaper()
        observations = []

        def reject(app, _natives):
            observations.append(app.pid)
            raise ValueError("expected identity-observer rejection")

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            outcome = PHASES.PAIRS.run_owned(
                [sys.executable, "-c", "import time;time.sleep(20)"],
                directory,
                directory / "case",
                2,
                observe=reject,
            )
            self.assertEqual(len(observations), 1)
            self.assertEqual(outcome["status"], "failed")
            self.assertEqual(
                outcome["error"],
                {
                    "type": "ValueError",
                    "message": "expected identity-observer rejection",
                },
            )
            self.assertTrue(outcome["cleanup"]["forced_termination"])
            self.assertEqual(outcome["cleanup"]["remaining_observed_pids"], [])
            self.assertEqual(outcome["cleanup"]["unreaped_observed_pids"], [])
            self.assertFalse(outcome.get("pipe_cleanup_failed"))
            self.assertNotIn(observations[0], PHASES.PAIRS.DRIVER.process_table())


if __name__ == "__main__":
    unittest.main()
