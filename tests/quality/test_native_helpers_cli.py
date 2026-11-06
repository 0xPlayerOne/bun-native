"""Pure helpers of the native CLI qualification scripts; no process is launched."""

import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / "tests" / "native"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, NATIVE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STANDALONE = load("native_helpers_cli_standalone", "cli-standalone.py")
TEMPLATES = load("native_helpers_cli_templates", "cli-templates.py")
OWNED_EXEC = load("native_helpers_cli_owned_exec", "cli-owned-exec.py")


class Executed(Exception):
    pass


class StandaloneFailureTests(unittest.TestCase):
    def test_first_error_is_primary_and_later_errors_are_secondary(self):
        report = {"status": "running"}
        STANDALONE.failure(report, RuntimeError("first"))
        self.assertEqual(report, {"status": "failed", "error": "first"})
        STANDALONE.failure(report, ValueError("second"))
        STANDALONE.failure(report, "third")
        self.assertEqual(report["error"], "first")
        self.assertEqual(report["secondary_errors"], ["second", "third"])

    def test_save_writes_result_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            STANDALONE.save(output, {"status": "passed", "count": 2})
            text = (output / "result.json").read_text(encoding="utf-8")
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(json.loads(text), {"status": "passed", "count": 2})


def receipt(**changes):
    record = {
        "status": "passed",
        "spawned": True,
        "process_audit_established": True,
        "process_audit_joined": True,
        "log_readers_joined": True,
        "cleanup": {
            "application_exit_code": 0,
            "remaining_observed_pids": [],
            "unreaped_observed_pids": [],
        },
    }
    cleanup = changes.pop("cleanup", {})
    record.update(changes)
    record["cleanup"] = {**record["cleanup"], **cleanup}
    return record


class StandaloneJoinedTests(unittest.TestCase):
    def test_complete_terminal_receipts_are_joined(self):
        self.assertTrue(STANDALONE.joined(receipt()))
        self.assertTrue(STANDALONE.joined(receipt(status="failed")))
        self.assertTrue(
            STANDALONE.joined(receipt(cleanup={"application_exit_code": 1}))
        )

    def test_non_terminal_records_are_never_joined(self):
        for status in (None, "running", "starting", "PASSED"):
            with self.subTest(status=status):
                self.assertFalse(STANDALONE.joined(receipt(status=status)))
                self.assertFalse(
                    STANDALONE.joined({"status": status, "spawned": False})
                )
        self.assertFalse(STANDALONE.joined({}))

    def test_terminal_unspawned_record_is_joined_without_audit(self):
        self.assertTrue(STANDALONE.joined({"status": "failed", "spawned": False}))
        # Only an explicit False proves no child was created.
        self.assertFalse(STANDALONE.joined({"status": "failed", "spawned": None}))
        self.assertFalse(STANDALONE.joined({"status": "failed"}))

    def test_each_missing_proof_breaks_the_join(self):
        for key in (
            "process_audit_established",
            "process_audit_joined",
            "log_readers_joined",
        ):
            for value in (False, None, 1, "true"):
                with self.subTest(key=key, value=value):
                    self.assertFalse(STANDALONE.joined(receipt(**{key: value})))
        for cleanup in (
            {"application_exit_code": None},
            {"remaining_observed_pids": [12]},
            {"remaining_observed_pids": None},
            {"unreaped_observed_pids": [12]},
            {"unreaped_observed_pids": ()},
        ):
            with self.subTest(cleanup=cleanup):
                self.assertFalse(STANDALONE.joined(receipt(cleanup=cleanup)))
        record = receipt()
        del record["cleanup"]
        self.assertFalse(STANDALONE.joined(record))


class StandaloneEnvironmentTests(unittest.TestCase):
    def test_environment_isolates_toolchains_and_caches(self):
        output = Path("evidence") / "standalone"
        bun = Path("toolchain") / "bin" / "bun"
        inherited = {
            "PATH": "inherited-path",
            "NODE_PATH": "x",
            "BUN_INSTALL": "x",
            "BUN_NATIVE_HOST": "x",
            "NODE_OPTIONS": "x",
            "BUN_OPTIONS": "x",
            "BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR": "x",
            "KEEP_ME": "kept",
        }
        with patch.dict(os.environ, inherited, clear=True):
            environment = STANDALONE.environment(output, bun)
            self.assertEqual(os.environ["NODE_PATH"], "x")
        for name in (
            "NODE_PATH",
            "BUN_INSTALL",
            "BUN_NATIVE_HOST",
            "NODE_OPTIONS",
            "BUN_OPTIONS",
            "BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR",
        ):
            self.assertNotIn(name, environment)
        tools = output / "sentinels"
        self.assertEqual(environment["KEEP_ME"], "kept")
        self.assertEqual(
            environment["PATH"].split(os.pathsep),
            [str(tools), str(bun.parent), "inherited-path"],
        )
        self.assertEqual(
            environment["BUN_INSTALL_CACHE_DIR"], str(output / "owned" / "cache")
        )
        self.assertEqual(
            environment["BUN_NATIVE_SENTINEL_LOG"],
            str(output / "sentinel-invocations.log"),
        )
        self.assertEqual(environment["BUN_NATIVE_HOST_PROFILE"], "release")
        self.assertEqual(environment["NO_COLOR"], "1")
        self.assertEqual(environment["FORCE_COLOR"], "0")
        for name in ("cargo", "rustc", "rustup"):
            self.assertEqual(environment[name.upper()], str(tools / name))

    def test_environment_without_inherited_path(self):
        with patch.dict(os.environ, {}, clear=True):
            environment = STANDALONE.environment(Path("out"), Path("bin") / "bun")
        self.assertEqual(
            environment["PATH"].split(os.pathsep),
            [str(Path("out") / "sentinels"), "bin", ""],
        )


class StandaloneExpectedInputsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name).resolve() / "consumer"
        (self.project / "src").mkdir(parents=True)
        self.source = self.project / "src" / "index.ts"
        self.source.write_bytes(b"export {}\n")
        inventory = patch.object(STANDALONE.LOCAL, "installed_inventory")
        self.inventory = inventory.start()
        self.addCleanup(inventory.stop)

    def test_matching_inputs_pass_after_inventory(self):
        case = {"inputs": {"src/index.ts": TEMPLATES.artifact(self.source)}}
        STANDALONE.expected_inputs(self.project, case, {"packages": {}})
        self.inventory.assert_called_once_with(self.project, {"packages": {}})

    def test_changed_input_is_rejected(self):
        case = {"inputs": {"src/index.ts": {"bytes": 1, "sha256": "0" * 64}}}
        with self.assertRaisesRegex(RuntimeError, "Artifact identity changed"):
            STANDALONE.expected_inputs(self.project, case, {})

    def test_escaping_input_is_rejected(self):
        outside = self.project.parent / "outside.ts"
        outside.write_bytes(b"x")
        case = {"inputs": {"../outside.ts": TEMPLATES.artifact(outside)}}
        with self.assertRaisesRegex(RuntimeError, "Consumer input escapes"):
            STANDALONE.expected_inputs(self.project, case, {})

    def test_missing_input_is_rejected(self):
        case = {"inputs": {"src/missing.ts": {"bytes": 0, "sha256": ""}}}
        with self.assertRaises(FileNotFoundError):
            STANDALONE.expected_inputs(self.project, case, {})


class TemplateArtifactTests(unittest.TestCase):
    def test_artifact_and_require_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "artifact.bin"
            path.write_bytes(b"bun-native\r\n")
            identity = TEMPLATES.artifact(path)
            self.assertEqual(
                identity,
                {
                    "bytes": 12,
                    "sha256": hashlib.sha256(b"bun-native\r\n").hexdigest(),
                },
            )
            # Extra recorded keys (for example a path) do not affect identity.
            TEMPLATES.require_artifact(path, {**identity, "path": "elsewhere"})
            with self.assertRaisesRegex(RuntimeError, "Artifact identity changed"):
                TEMPLATES.require_artifact(path, {**identity, "bytes": 13})
            with self.assertRaises(KeyError):
                TEMPLATES.require_artifact(path, {"sha256": identity["sha256"]})

    def test_cases_cover_both_frameworks_and_languages(self):
        self.assertEqual(
            TEMPLATES.CASES,
            [
                "solid-typescript",
                "solid-javascript",
                "react-typescript",
                "react-javascript",
            ],
        )

    def test_source_identity_from_git_listing(self):
        files = {"a.txt": b"alpha", "dir/b.txt": b"beta!"}
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary)
            for name, content in files.items():
                (repository / name).parent.mkdir(parents=True, exist_ok=True)
                (repository / name).write_bytes(content)
            outputs = {
                ("rev-parse", "HEAD"): b"abc123\n",
                ("status", "--porcelain"): b"",
                ("ls-files", "-z"): b"dir/b.txt\0a.txt\0",
            }
            calls = []

            def check_output(command, cwd, timeout):
                calls.append((command, cwd, timeout))
                self.assertEqual(command[0], "git")
                return outputs[tuple(command[1:])]

            with (
                patch.object(TEMPLATES, "REPOSITORY", repository),
                patch.object(TEMPLATES.subprocess, "check_output", check_output),
            ):
                clean = TEMPLATES.source_identity()
                outputs[("status", "--porcelain")] = b" M a.txt\n"
                dirty = TEMPLATES.source_identity()
        self.assertEqual(clean["commit"], "abc123")
        self.assertFalse(clean["dirty"])
        self.assertTrue(dirty["dirty"])
        self.assertEqual(
            clean["files"],
            [
                {
                    "path": "a.txt",
                    "bytes": 5,
                    "sha256": hashlib.sha256(b"alpha").hexdigest(),
                },
                {
                    "path": "dir/b.txt",
                    "bytes": 5,
                    "sha256": hashlib.sha256(b"beta!").hexdigest(),
                },
            ],
        )
        self.assertTrue(
            all(cwd == repository and timeout == 10 for _, cwd, timeout in calls)
        )

    def test_counter_command(self):
        output = Path("evidence") / "solid"
        command = TEMPLATES.counter_command(
            "solid", "aot", output, ["bun", "run", "--", "app"]
        )
        self.assertEqual(command[0], sys.executable)
        self.assertEqual(
            command[1],
            str(TEMPLATES.REPOSITORY / "scripts/quality/native-input-linux.py"),
        )
        separator = command.index("--")
        self.assertEqual(command[separator + 1 :], ["bun", "run", "--", "app"])
        driver = command[:separator]
        self.assertEqual(driver[driver.index("--output") + 1], str(output))
        self.assertEqual(driver[driver.index("--mode") + 1], "aot")
        self.assertEqual(driver[driver.index("--title") + 1], "Bun Native Solid")
        self.assertEqual(driver[driver.index("--timeout") + 1], "30")
        for flag in (
            "--expect-software-renderer",
            "--expect-native-pointer",
            "--require-unforced-cleanup",
        ):
            self.assertIn(flag, driver)
        click = driver.index("--click")
        self.assertEqual(driver[click + 1 : click + 3], ["100", "130"])
        initial = json.loads(driver[driver.index("--expect-initial-render") + 1])
        final = json.loads(driver[driver.index("--expect-render") + 1])
        self.assertEqual(initial, TEMPLATES.counter_paint("solid", 0))
        self.assertEqual(final, TEMPLATES.counter_paint("solid", 1))
        self.assertEqual(
            TEMPLATES.counter_command("react", "development", output, [])[-1], "--"
        )


@unittest.skipIf(sys.platform == "win32", "select() on pipe descriptors is POSIX-only")
class OwnedExecHandshakeTests(unittest.TestCase):
    def run_main(self, payload):
        read, write = os.pipe()
        self.addCleanup(lambda: os.close(write))
        if payload:
            os.write(write, payload)
        calls = []

        def execvpe(file, args, env):
            calls.append((file, list(args), env))
            raise Executed

        argv = ["cli-owned-exec.py", str(read), "bun", "--flag", "value with space"]
        with (
            patch.object(sys, "argv", argv),
            patch.object(OWNED_EXEC.os, "execvpe", execvpe),
        ):
            try:
                OWNED_EXEC.main()
            except Executed:
                pass
            finally:
                with self.assertRaises(OSError):
                    os.fstat(read)
        return calls

    def test_release_byte_execs_unchanged_argv(self):
        calls = self.run_main(b"!")
        self.assertEqual(len(calls), 1)
        file, args, env = calls[0]
        self.assertEqual(file, "bun")
        self.assertEqual(args, ["bun", "--flag", "value with space"])
        self.assertIs(env, os.environ)

    def test_wrong_byte_is_rejected_and_descriptor_closed(self):
        with self.assertRaisesRegex(RuntimeError, "handshake was not released"):
            self.run_main(b"?")


class OwnedExecArgumentTests(unittest.TestCase):
    def test_requires_descriptor_and_executable(self):
        for argv in (["x"], ["x", "5"]):
            with (
                self.subTest(argv=argv),
                patch.object(sys, "argv", argv),
                self.assertRaisesRegex(ValueError, "are required"),
            ):
                OWNED_EXEC.main()

    def test_rejects_standard_stream_descriptors(self):
        for descriptor in ("0", "1", "2", "-1"):
            with (
                self.subTest(descriptor=descriptor),
                patch.object(sys, "argv", ["x", descriptor, "bun"]),
                patch.object(OWNED_EXEC.os, "close") as close,
                self.assertRaisesRegex(ValueError, "standard stream"),
            ):
                OWNED_EXEC.main()
            close.assert_not_called()

    def test_rejects_non_integer_descriptor(self):
        with (
            patch.object(sys, "argv", ["x", "fd", "bun"]),
            self.assertRaises(ValueError),
        ):
            OWNED_EXEC.main()

    def test_timeout_is_five_seconds_and_closes_descriptor(self):
        waits = []

        def select(readable, writable, exceptional, timeout):
            waits.append((readable, writable, exceptional, timeout))
            return [], [], []

        with (
            patch.object(sys, "argv", ["x", "41", "bun"]),
            patch.object(OWNED_EXEC.select, "select", select),
            patch.object(OWNED_EXEC.os, "read") as read,
            patch.object(OWNED_EXEC.os, "close") as close,
            patch.object(OWNED_EXEC.os, "execvpe") as execvpe,
            self.assertRaisesRegex(RuntimeError, "handshake was not released"),
        ):
            OWNED_EXEC.main()
        self.assertEqual(waits, [([41], [], [], 5)])
        read.assert_not_called()
        close.assert_called_once_with(41)
        execvpe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
