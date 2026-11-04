"""Headless watch-oracle and ownership guards; no native GUI acceptance."""

import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tests/native/cli-watch.py"
SPEC = importlib.util.spec_from_file_location("cli_watch", SCRIPT)
WATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WATCH)
PROCESS = WATCH.PROCESS
ZERO = {
    "pid": 200,
    "clean": True,
    "nodes": 0,
    "application": {key: 0 for key in WATCH.RESOURCE_KEYS},
}


def row(pid, parent, group, started, state="S"):
    return {
        "pid": pid,
        "parent_pid": parent,
        "process_group": group,
        "start_ticks": started,
        "state": state,
        "rss_bytes": 4096,
    }


class WatchOracleTests(unittest.TestCase):
    def test_fixed_count_and_source_tokens_require_reset_and_one_click_per_generation(
        self,
    ):
        self.assertEqual(WATCH.EDIT_COUNT, 101)
        self.assertEqual(WATCH.GENERATIONS, 102)
        for framework in ("solid", "react"):
            title = f"Bun Native {framework.title()}"
            original = f'<text text="{title}" />\nconst window = {{title: \'{title}\'}}\nconst untouched = "counter and lifecycle"\n'
            tokens = set()
            for index in range(102):
                token = f"{framework.title()} abcdef01 {index:03d}"
                source = WATCH.generation_source(original, framework, token)
                self.assertEqual(source.replace(token, title), original)
                self.assertEqual(source.count(token), 2)
                tokens.add(token)
                initial = WATCH.paint(framework, token, 0)
                final = WATCH.paint(framework, token, 1)
                self.assertEqual(initial["nodes"][3]["element"]["text"], token)
                self.assertEqual(initial["nodes"][4]["element"]["text"], "Clicks: 0")
                self.assertEqual(final["nodes"][4]["element"]["text"], "Clicks: 1")
                self.assertFalse(WATCH.DRIVER.matches_paint(initial, final))
                if index:
                    self.assertFalse(
                        WATCH.DRIVER.matches_paint(
                            WATCH.paint(
                                framework,
                                f"{framework.title()} abcdef01 {index - 1:03d}",
                                1,
                            ),
                            final,
                        )
                    )
            self.assertEqual(len(tokens), 102)
            for token in [
                'injected" />',
                "x" * 100,
                f"{framework.title()} abcdef01 001\n",
            ]:
                with self.assertRaisesRegex(RuntimeError, "unchanged template"):
                    WATCH.generation_source(original, framework, token)

    def test_teardown_requires_every_counter_and_the_expected_process(self):
        WATCH.zero_teardown(ZERO, 200)
        damaged = [
            None,
            {},
            {**ZERO, "pid": True},
            {**ZERO, "pid": 201},
            {**ZERO, "clean": 1},
            {**ZERO, "nodes": False},
            {**ZERO, "nodes": 1},
        ]
        for key in WATCH.RESOURCE_KEYS:
            for value in (1, False, None):
                damaged.append(
                    {**ZERO, "application": {**ZERO["application"], key: value}}
                )
        for value in damaged:
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(RuntimeError, "acknowledgement"),
            ):
                WATCH.zero_teardown(value, 200)

    def test_ready_requires_one_owned_bundle_and_an_ordered_validated_transition(self):
        with tempfile.TemporaryDirectory(prefix="bun-native-dev-") as directory:
            root = Path(directory).resolve()
            generation = root / "generation-a"
            generation.mkdir()
            module = generation / "application.js"
            module.write_text("export {}\n")
            valid = {
                "generation": 1,
                "pid": 200,
                "bundle": str(module),
                "bundleMs": 2,
                "shutdownMs": 0,
                "mountMs": 3,
                "editToReadyMs": 5,
            }
            self.assertEqual(WATCH.validate_ready(valid, 0, None, None), (module, root))
            second = {**valid, "generation": 2, "pid": 300, "previous": ZERO}
            WATCH.validate_ready(second, 1, {"pid": 200, "start_ticks": 99}, root)
            for changed in [
                {"generation": 3},
                {"generation": True},
                {"pid": True},
                {"bundle": "relative/application.js"},
                {"mountMs": float("nan")},
                {"bundleMs": True},
                {"editToReadyMs": -1},
                {"previous": None},
            ]:
                with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                    WATCH.validate_ready({**second, **changed}, 1, {"pid": 200}, root)
            extra = root / "generation-unretired"
            extra.mkdir()
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                WATCH.validate_ready(valid, 0, None, root)

    def test_partial_old_records_and_old_generations_cannot_satisfy_current_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "native.jsonl"
            old = json.dumps({"nonce": "old", "type": "pointer_trace"}) + "\n"
            current = {
                "nonce": "current",
                **WATCH.paint("solid", "Solid abcdef01 002", 1),
            }
            path.write_text(old + json.dumps(current) + "\n")
            observation = {
                "start_byte_offset": 4,
                "ignored_preexisting_partial_record": True,
            }
            self.assertEqual(
                WATCH.records_after(path, "current", observation), [current]
            )
            with self.assertRaisesRegex(RuntimeError, "nonce"):
                WATCH.records_after(path, "other", observation)
            path.write_text(old[:10])
            self.assertEqual(WATCH.records_after(path, "current", observation), [])

    def test_malformed_edit_matches_pinned_diagnostics_only_after_its_offset(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "stderr.log"
            entry = Path(directory) / "app/main.tsx"
            text = f"Bundle failed\n1 | const incomplete = <\nerror: Unexpected token\n    at {entry}:1:21\n"
            log.write_text(text)
            for framework in ("solid", "react"):
                self.assertTrue(WATCH.malformed_diagnostic(log, 0, entry, framework))
                self.assertFalse(
                    WATCH.malformed_diagnostic(
                        log, len(text.encode()), entry, framework
                    )
                )
            for changed in [
                text.replace("Bundle failed", "Host failed"),
                text.replace(str(entry), str(entry) + ".old"),
                text.replace("const incomplete = <", "unrelated source"),
            ]:
                log.write_text(changed)
                self.assertFalse(WATCH.malformed_diagnostic(log, 0, entry, "solid"))

    def test_capture_bounds_records_logs_and_strict_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = b'Watching project source\nbun-native:ready {"generation":1}\nbun-native:stopped {"clean":true}\n'
            capture = PROCESS.Capture(
                io.BytesIO(payload), root / "valid.log", record_limit=2, parse=True
            )
            capture.thread.join(timeout=1)
            records = capture.snapshot()
            self.assertEqual(
                [record["kind"] for record in records], ["ready", "stopped"]
            )
            self.assertLessEqual(records[0]["observed_ns"], records[1]["observed_ns"])
            self.assertEqual((root / "valid.log").read_bytes(), payload)
            for index, data in enumerate(
                [
                    b'bun-native:ready {"pid":1,"pid":2}\n',
                    b'bun-native:ready {"time":NaN}\n',
                    b"x" * (WATCH.DRIVER.PAINT_OBSERVER.MAX_RECORD_BYTES + 1),
                    b"bun-native:ready {}\n" * 3,
                ]
            ):
                failed = PROCESS.Capture(
                    io.BytesIO(data),
                    root / f"bad-{index}.log",
                    record_limit=2,
                    parse=True,
                )
                failed.thread.join(timeout=1)
                with self.assertRaises(RuntimeError):
                    failed.snapshot()
            oversized = PROCESS.Capture(
                io.BytesIO(b"x" * (WATCH.DRIVER.MAX_LOG_BYTES + 99)),
                root / "bounded.log",
                record_limit=1,
            )
            oversized.thread.join(timeout=2)
            self.assertEqual(
                (root / "bounded.log").stat().st_size, WATCH.DRIVER.MAX_LOG_BYTES
            )
            self.assertEqual(oversized.discarded, 99)
            with self.assertRaisesRegex(RuntimeError, "4 MiB"):
                oversized.snapshot()

    @unittest.skipUnless(sys.platform == "linux", "POSIX sentinel contract")
    def test_owned_path_sentinel_fails_real_build_tool_attempts(self):
        with tempfile.TemporaryDirectory() as directory:
            log = WATCH.sentinel(Path(directory) / "sentinel")
            env = {
                **os.environ,
                "PATH": str(log.parent),
                "BUN_NATIVE_BUILD_SENTINEL": str(log),
            }
            for command in ("cargo", "rustc", "rustup"):
                result = subprocess.run(
                    [command, "--version"],
                    env=env,
                    capture_output=True,
                    timeout=3,
                    check=False,
                )
                self.assertEqual(result.returncode, 97)
            self.assertEqual(len(log.read_text().splitlines()), 3)

    @unittest.skipUnless(sys.platform == "linux", "Linux native harness")
    def test_unavailable_display_never_launches_or_reports_native_success(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "evidence"
            env = dict(os.environ)
            env.pop("DISPLAY", None)
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--framework",
                    "solid",
                    "--output",
                    str(output),
                    "--host",
                    sys.executable,
                    "--bun",
                    sys.executable,
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            self.assertEqual(result.returncode, 2, result.stderr)
            report = json.loads((output / "result.json").read_text())
            self.assertEqual(report["status"], "unsupported")
            self.assertEqual(report["generations"], [])
            self.assertNotIn("command", report)


class ImmutableOwnershipTests(unittest.TestCase):
    def test_root_reuse_never_authorizes_an_earlier_sorted_foreign_descendant(self):
        ownership = PROCESS.Ownership({"pid": 200, "start_ticks": 10})
        foreign = {50: row(50, 200, 200, 900), 200: row(200, 1, 200, 901)}
        self.assertEqual(ownership.rows(foreign), [])
        self.assertEqual(ownership.observed, {200: 10})
        self.assertFalse(ownership.discovering)

    def test_root_absence_permanently_freezes_discovery_but_retains_owned_orphans(self):
        ownership = PROCESS.Ownership({"pid": 200, "start_ticks": 10})
        initial = {200: row(200, 1, 200, 10), 210: row(210, 200, 200, 11)}
        self.assertEqual(len(ownership.rows(initial)), 2)
        orphan = {210: row(210, 1, 200, 11), 50: row(50, 1, 200, 900)}
        self.assertEqual([item["pid"] for item in ownership.rows(orphan)], [210])
        revived = {**initial, 50: row(50, 200, 200, 901)}
        self.assertEqual([item["pid"] for item in ownership.rows(revived)], [200, 210])
        self.assertEqual(ownership.observed, {200: 10, 210: 11})

    def test_child_reuse_rejects_the_entire_snapshot_without_partial_new_claims(self):
        ownership = PROCESS.Ownership({"pid": 200, "start_ticks": 10})
        initial = {200: row(200, 1, 200, 10), 210: row(210, 200, 200, 11)}
        ownership.rows(initial)
        changed = {**initial, 50: row(50, 200, 200, 12), 210: row(210, 200, 200, 99)}
        with self.assertRaisesRegex(RuntimeError, "reused"):
            ownership.rows(changed)
        self.assertEqual(ownership.observed, {200: 10, 210: 11})

    def test_teardown_checks_keep_the_original_identity_including_zombies(self):
        identity = {"pid": 210, "start_ticks": 11}
        alive = {210: row(210, 200, 200, 11)}
        PROCESS.require_identity(alive, identity)
        for state in ("S", "Z"):
            changed = copy.deepcopy(alive)
            changed[210]["state"] = state
            with self.assertRaisesRegex(RuntimeError, "still live or unreaped"):
                PROCESS.require_absent(changed, [identity])
        recycled = {210: row(210, 1, 999, 12)}
        PROCESS.require_absent(recycled, [identity])
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            PROCESS.require_identity(recycled, identity)


if __name__ == "__main__":
    unittest.main()
