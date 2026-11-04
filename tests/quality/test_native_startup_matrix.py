"""Deterministic controller contracts; these do not run native graphics."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[2] / "experiments/native-startup-matrix.py"
SPEC = importlib.util.spec_from_file_location("startup_matrix", PATH)
MATRIX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATRIX)


class StartupMatrixTests(unittest.TestCase):
    def test_fixed_plan_covers_each_case_without_adaptive_retries(self):
        rows = MATRIX.plan()
        self.assertEqual(len(rows), 19)
        self.assertEqual(len({row["name"] for row in rows}), 19)
        self.assertIsNone(rows[0]["cache"])
        for index in range(1, len(rows), 2):
            cold, warm = rows[index : index + 2]
            self.assertEqual(cold["cache_state"], "empty")
            self.assertEqual(warm["cache_state"], "reused")
            self.assertEqual(cold["cache"], warm["cache"])
            self.assertEqual(cold["workers"], warm["workers"])
        for workers in (None, 1, 2):
            self.assertEqual(sum(row["workers"] == workers for row in rows[1:]), 6)

    def test_original_environment_preserves_driver_configuration(self):
        base = {
            "LP_NUM_THREADS": "7",
            "MESA_SHADER_CACHE_DIR": "/existing",
            "PATH": "/bun",
        }
        value = MATRIX.environment(
            base, MATRIX.plan()[0], Path("/private/unused"), "fixture"
        )
        for key, original in base.items():
            self.assertEqual(value[key], original)
        self.assertEqual(base["LP_NUM_THREADS"], "7")

    def test_only_declared_counterfactuals_change_worker_or_cache_settings(self):
        base = {"LP_NUM_THREADS": "7", "PATH": "/bun"}
        for row in MATRIX.plan()[1:]:
            value = MATRIX.environment(base, row, Path("/owned/cache"), "fixture")
            self.assertEqual(
                value.get("LP_NUM_THREADS"),
                None if row["workers"] is None else str(row["workers"]),
            )
            self.assertEqual(value["MESA_SHADER_CACHE_DIR"], "/owned/cache")
            self.assertEqual(value["PATH"], "/bun")
            self.assertEqual(value["BUN_NATIVE_STARTUP_TRACE"], "1")
        self.assertEqual(base, {"LP_NUM_THREADS": "7", "PATH": "/bun"})

    def test_phase_summary_uses_one_native_clock_and_keeps_failed_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "events.jsonl"
            header = {
                "stage": "startup-diagnostic",
                "source": "native",
                "request_id": 3,
                "nonce": "fixture",
            }
            rows = [{**header, "phase": "open_window_enter", "elapsed_ns": "1000000"}]
            path.write_text(json.dumps(rows[0]) + "\n")
            result = MATRIX.observations(path, "fixture")
            self.assertIsNone(result["first_open_native_ms"])
            self.assertEqual(result["first_open_phases"], ["open_window_enter"])
            rows.append(
                {**header, "phase": "open_window_returned", "elapsed_ns": "4000000"}
            )
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            self.assertEqual(
                MATRIX.observations(path, "fixture")["first_open_native_ms"], 3
            )
            with self.assertRaisesRegex(ValueError, "Foreign"):
                MATRIX.observations(path, "another")
            rows[-1]["elapsed_ns"] = "0"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            with self.assertRaisesRegex(ValueError, "backwards"):
                MATRIX.observations(path, "fixture")

    def test_cache_inventory_never_counts_missing_or_deleted_artifacts_as_warm(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assertEqual(
                MATRIX.cache_inventory(directory), {"files": 0, "bytes": 0}
            )
            (directory / "fixture").write_bytes(b"123")
            self.assertEqual(
                MATRIX.cache_inventory(directory), {"files": 1, "bytes": 3}
            )
            self.assertEqual(
                MATRIX.observations(directory / "absent", "fixture"),
                {"records": 0, "missing": True},
            )


if __name__ == "__main__":
    unittest.main()
