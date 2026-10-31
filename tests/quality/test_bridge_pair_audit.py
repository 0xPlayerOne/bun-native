"""Offline evidence integrity controls; no native execution or performance claim."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
import warnings
import zipfile


SCRIPT = Path(__file__).resolve().parents[2] / "benchmarks/audit-bridge-pairs.py"
SPEC = importlib.util.spec_from_file_location("bridge_pair_audit", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def archive(self, contents):
        path = self.directory / "evidence.zip"
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as output:
                for name, data in contents:
                    output.writestr(name, data)
        return path, AUDIT.PAIRS.BASELINE.fingerprint(path)

    def test_reads_an_exact_archive_without_extracting_files(self):
        path, receipt = self.archive([("metadata.json", '{"value":1e308}')])
        archive = AUDIT.Archive(path, receipt)
        try:
            self.assertEqual(archive.json("metadata.json"), {"value": 1e308})
            self.assertEqual(list(self.directory.iterdir()), [path])
        finally:
            archive.close()

    def test_changed_bytes_cannot_reuse_the_original_artifact_receipt(self):
        path, receipt = self.archive([("metadata.json", "{}")])
        with path.open("ab") as output:
            output.write(b"changed archive")
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            AUDIT.Archive(path, receipt)

    def test_reads_the_verified_snapshot_if_the_path_is_replaced(self):
        path, receipt = self.archive([("metadata.json", '{"original":true}')])
        archive = AUDIT.Archive(path, receipt)
        try:
            self.archive([("metadata.json", '{"original":false}')])
            self.assertEqual(archive.json("metadata.json"), {"original": True})
        finally:
            archive.close()

    def test_rejects_duplicate_traversal_and_symlink_members(self):
        link = zipfile.ZipInfo("link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for contents in [
            [("same", "one"), ("same", "two")],
            [("../outside", "content")],
            [("/outside", "content")],
            [("folder\\outside", "content")],
            [(link, "/outside")],
        ]:
            with self.subTest(contents=contents):
                path, receipt = self.archive(contents)
                with self.assertRaises(ValueError):
                    AUDIT.Archive(path, receipt)

    def test_compressed_oversize_member_is_rejected_before_reading(self):
        path, receipt = self.archive(
            [("metadata.json", b"x" * (AUDIT.PAIRS.MAX_JSON_BYTES + 1))]
        )
        self.assertLess(path.stat().st_size, 8192)
        with self.assertRaisesRegex(ValueError, "member exceeds"):
            AUDIT.Archive(path, receipt)

    def test_nonfinite_tokens_and_numeric_exponents_are_rejected(self):
        for value in ["NaN", "Infinity", "-Infinity", "1e999", "-1e999"]:
            with self.subTest(value=value):
                path, receipt = self.archive(
                    [("metadata.json", '{"value":' + value + "}")]
                )
                archive = AUDIT.Archive(path, receipt)
                try:
                    with self.assertRaisesRegex(ValueError, "Non-finite"):
                        archive.json("metadata.json")
                finally:
                    archive.close()


class CollectionTests(unittest.TestCase):
    def setUp(self):
        start = datetime(2026, 10, 31, tzinfo=timezone.utc)
        self.plan = {
            "plan": AUDIT.PAIRS.plan_trials(5, 1),
            "build": {"sha256": "inert"},
            "methodology": {"inert": True},
            "controller": [],
        }
        self.build = {
            "status": "passed",
            "finished_at": (start - timedelta(seconds=1)).isoformat(),
            "controller": [],
        }
        self.summary = {
            **deepcopy(self.plan),
            "status": "passed",
            "started_at": start.isoformat(),
            "trials": [
                {
                    **row,
                    "status": "passed",
                    "supervisor": {
                        "started_at": (
                            start + timedelta(seconds=index * 2)
                        ).isoformat(),
                        "finished_at": (
                            start + timedelta(seconds=index * 2 + 1)
                        ).isoformat(),
                    },
                }
                for index, row in enumerate(self.plan["plan"])
            ],
        }

    def test_accepts_complete_predeclared_nonoverlapping_order(self):
        AUDIT.verify_plan(self.summary, self.plan, self.build)

    def test_a_failed_warmup_cannot_be_removed_or_hidden_by_measured_pairs(self):
        failed = deepcopy(self.summary)
        failed["trials"][0]["status"] = "failed"
        with self.assertRaisesRegex(ValueError, "Failed observation"):
            AUDIT.verify_plan(failed, self.plan, self.build)
        failed["trials"].pop(0)
        with self.assertRaisesRegex(ValueError, "Missing or extra"):
            AUDIT.verify_plan(failed, self.plan, self.build)

    def test_reordered_rows_and_concurrent_or_backward_intervals_fail(self):
        reordered = deepcopy(self.summary)
        reordered["trials"][4:6] = reversed(reordered["trials"][4:6])
        with self.assertRaisesRegex(ValueError, "order differs"):
            AUDIT.verify_plan(reordered, self.plan, self.build)
        overlap = deepcopy(self.summary)
        overlap["trials"][1]["supervisor"]["started_at"] = overlap["trials"][0][
            "supervisor"
        ]["started_at"]
        with self.assertRaisesRegex(ValueError, "overlap"):
            AUDIT.verify_plan(overlap, self.plan, self.build)

    def test_build_overlap_and_changed_methodology_are_not_paired_evidence(self):
        late = {
            **self.build,
            "finished_at": self.summary["trials"][0]["supervisor"]["finished_at"],
        }
        with self.assertRaisesRegex(ValueError, "Compilation overlapped"):
            AUDIT.verify_plan(self.summary, self.plan, late)
        changed = deepcopy(self.summary)
        changed["methodology"]["instrumentation"] = "enabled halfway"
        with self.assertRaisesRegex(ValueError, "Methodology changed"):
            AUDIT.verify_plan(changed, self.plan, self.build)


if __name__ == "__main__":
    unittest.main()
