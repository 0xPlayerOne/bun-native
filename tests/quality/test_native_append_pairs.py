"""Paired controller checks; native painting is qualified by the hosted job."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_append_pairs", ROOT / "benchmarks/renderer/native_append_pairs.py"
)
PAIRS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAIRS)


class NativeAppendPairsTests(unittest.TestCase):
    def run_controller(self, root, mismatch=False):
        root = Path(root)
        binaries = root / "binaries"
        binaries.mkdir()
        for name in ("baseline.js", "candidate.js", "baseline-aot", "candidate-aot"):
            (binaries / name).write_text(name)
        bun = root / "bun"
        host = root / "host"
        metadata = root / "sources.json"
        bun.write_text("bun")
        host.write_text("host")
        metadata.write_text("{}")
        output = root / "results"
        order = []

        def run_owned(command, cwd, run_dir, timeout, *, expected_host):
            run_dir.mkdir()
            order.append(run_dir.name)
            candidate = run_dir.name.endswith("candidate")
            observation = {
                "status": "passed",
                "initialTree": ["different" if candidate and mismatch else "same"],
                "renderer": {"type": "renderer", "nonce": run_dir.name},
                "timings": [{"ackMs": 1.0, "paintObservedMs": 2.0}] * 8,
            }
            (run_dir / "result.json").write_text(json.dumps(observation))
            return {"status": "passed"}

        arguments = [
            "native_append_pairs.py",
            str(bun),
            str(host),
            str(binaries),
            str(output),
            str(metadata),
        ]
        with (
            patch.object(PAIRS, "run_owned", side_effect=run_owned),
            patch.object(PAIRS.sys, "argv", arguments),
        ):
            if mismatch:
                with self.assertRaisesRegex(ValueError, "initial tree changed"):
                    PAIRS.main()
            else:
                PAIRS.main()
        return json.loads((output / "summary.json").read_text()), order

    def test_alternating_pairs_and_warmup_are_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            result, order = self.run_controller(directory)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(len(order), 24)
        self.assertEqual(
            order[:4],
            [
                "00-dev-baseline",
                "00-dev-candidate",
                "00-aot-baseline",
                "00-aot-candidate",
            ],
        )
        self.assertEqual(
            order[4:8],
            [
                "01-aot-candidate",
                "01-aot-baseline",
                "01-dev-candidate",
                "01-dev-baseline",
            ],
        )
        self.assertEqual(
            len(result["comparisons"]["aot/medianAckMs"]["pairedRatios"]), 5
        )

    def test_mismatched_native_tree_is_a_retained_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result, order = self.run_controller(directory, mismatch=True)
        self.assertEqual(result["status"], "failed")
        self.assertIn("initial tree changed", result["error"])
        self.assertNotIn("comparisons", result)
        self.assertEqual(len(order), 2)


if __name__ == "__main__":
    unittest.main()
