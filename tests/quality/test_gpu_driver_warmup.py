"""Checks for the hosted software-GPU driver page-cache warmup (#296)."""

import json
import tempfile
import unittest
from pathlib import Path

from scripts.quality.native_harness import warm_gpu_driver as WARMUP

ROOT = Path(__file__).resolve().parents[2]


class GpuDriverWarmup(unittest.TestCase):
    def test_reads_icd_library_path(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "lvp_icd.json"
            manifest.write_text(
                json.dumps({"ICD": {"library_path": "/usr/lib/x/libvulkan_lvp.so"}})
            )
            self.assertEqual(
                WARMUP.icd_library(manifest), "/usr/lib/x/libvulkan_lvp.so"
            )
            manifest.write_text(json.dumps({"ICD": {}}))
            with self.assertRaises(ValueError):
                WARMUP.icd_library(manifest)

    def test_reads_only_mesa_egl_vendor_manifests(self):
        with tempfile.TemporaryDirectory() as directory:
            vendor = Path(directory)
            (vendor / "50_mesa.json").write_text(
                json.dumps({"ICD": {"library_path": "libEGL_mesa.so.0"}})
            )
            (vendor / "10_nvidia.json").write_text(
                json.dumps({"ICD": {"library_path": "libEGL_nvidia.so.0"}})
            )
            self.assertEqual(
                WARMUP.egl_vendor_libraries((vendor,)), ["libEGL_mesa.so.0"]
            )

    def test_resolves_sonames_through_ldconfig(self):
        output = (
            "1234 libs found in cache `/etc/ld.so.cache'\n"
            "\tlibEGL_mesa.so.0 (libc6,x86-64) => /lib/x86_64-linux-gnu/libEGL_mesa.so.0\n"
        )
        self.assertEqual(
            WARMUP.resolve("libEGL_mesa.so.0", output),
            Path("/lib/x86_64-linux-gnu/libEGL_mesa.so.0"),
        )
        self.assertEqual(WARMUP.resolve("/abs/libx.so", output), Path("/abs/libx.so"))
        self.assertIsNone(WARMUP.resolve("libmissing.so.1", output))

    def test_parses_resolved_ldd_entries_only(self):
        output = (
            "\tlinux-vdso.so.1 (0x00007ffd)\n"
            "\tlibLLVM.so.20.1 => /lib/x86_64-linux-gnu/libLLVM.so.20.1 (0x00007f00)\n"
            "\t/lib64/ld-linux-x86-64.so.2 (0x00007f01)\n"
            "\tlibmissing.so => not found\n"
        )
        self.assertEqual(
            WARMUP.ldd_dependencies(output),
            [
                Path("/lib/x86_64-linux-gnu/libLLVM.so.20.1"),
                Path("/lib64/ld-linux-x86-64.so.2"),
            ],
        )

    def test_warm_reads_every_byte_and_reports_residency(self):
        with tempfile.TemporaryDirectory() as directory:
            files = []
            for index, size in enumerate((0, 4097, 3 * WARMUP.CHUNK + 5)):
                path = Path(directory) / f"lib{index}.so"
                path.write_bytes(b"x" * size)
                files.append(path)
            report = WARMUP.warm(files)
            self.assertEqual(
                report["total_bytes"], sum(path.stat().st_size for path in files)
            )
            self.assertEqual(
                [record["path"] for record in report["files"]],
                [str(path) for path in files],
            )
            for record in report["files"]:
                self.assertGreaterEqual(record["read_seconds"], 0)
                self.assertLessEqual(record["resident_before_bytes"], record["bytes"])
            # Freshly written files are cached, so residency is observable.
            self.assertEqual(report["files"][1]["resident_before_bytes"], 4097)

    def test_bounds_the_closure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lib.so"
            path.write_bytes(b"x")
            with self.assertRaises(ValueError):
                WARMUP.warm([path] * (WARMUP.MAX_FILES + 1))


if __name__ == "__main__":
    unittest.main()
