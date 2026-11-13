"""Fixed installed-consumer preparation and eight shared native counter scenarios."""

import argparse
import json
import os
import platform
import secrets
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import cli_templates as TEMPLATES
from . import native_watch_processes as PROCESS
from . import standalone_packages as LOCAL
from .common import ROOT

EVIDENCE, DRIVER = LOCAL.EVIDENCE, PROCESS.DRIVER
require, digest = EVIDENCE.require, EVIDENCE.digest
ERRORS = LOCAL.COHORT_ERRORS + (DRIVER.Unsupported,)
MODES = ("development", "aot")
PLANNED = {
    "packs": 7,
    "creates": 4,
    "installs": 4,
    "checks": 4,
    "imports": 4,
    "builds": 4,
    "native_cases": 8,
}


def failure(report, error):
    message = str(error)
    report["status"] = "failed"
    if "error" not in report:
        report["error"] = message
    else:
        report.setdefault("secondary_errors", []).append(message)


def save(output, report):
    LOCAL.write_json(output / "result.json", report)


def joined(record):
    # A persisted pre-spawn record may outlive an abruptly terminated owner.
    # Only a terminal receipt can establish that no child was actually created.
    if record.get("status") not in ("passed", "failed"):
        return False
    if record.get("spawned") is False:
        return True
    cleanup = record.get("cleanup", {})
    return (
        record.get("process_audit_established") is True
        and record.get("process_audit_joined") is True
        and record.get("log_readers_joined") is True
        and cleanup.get("application_exit_code") is not None
        and cleanup.get("remaining_observed_pids") == []
        and cleanup.get("unreaped_observed_pids") == []
    )


def run_owned(
    report,
    output,
    name,
    command,
    cwd,
    environment,
    timeout,
    deadline,
    *,
    native_host=None,
):
    """Use the existing identity audit, bounded logs and cleanup for each command."""
    require(
        deadline - time.monotonic() >= timeout + 8,
        f"Insufficient fixed phase budget for the complete command bound: {name}",
    )
    record = {
        "name": name,
        "command": list(map(str, command)),
        "cwd": str(cwd),
        "timeout_seconds": timeout,
        "status": "running",
        "spawned": False,
        "process_audit_established": False,
    }
    report["commands"].append(record)
    save(output, report)
    app = audit = None
    captures = []
    read_start = write_start = None
    started = time.monotonic()
    try:
        read_start, write_start = os.pipe()
        record["launcher"] = [
            sys.executable,
            str(ROOT / "tests/native/cli-owned-exec.py"),
            str(read_start),
            *record["command"],
        ]
        record["start_handshake"] = {"bound_seconds": 5, "released": False}
        app = subprocess.Popen(
            record["launcher"],
            cwd=cwd,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            pass_fds=(read_start,),
        )
        os.close(read_start)
        read_start = None
        record["pid"] = app.pid
        record["spawned"] = True
        for stream, suffix in [(app.stdout, "stdout"), (app.stderr, "stderr")]:
            captures.append(
                PROCESS.Capture(
                    stream, output / "logs" / f"{name}.{suffix}.log", record_limit=0
                )
            )
        record["expected_native_host"] = str(native_host or report["host"]["path"])
        audit = PROCESS.ProcessAudit(
            app, record["expected_native_host"], report["bun"]["path"]
        )
        record["process_audit_established"] = True
        remaining = timeout - (time.monotonic() - started)
        require(remaining > 0, "Owned start handshake exhausted the command bound")
        os.write(write_start, b"!")
        os.close(write_start)
        write_start = None
        record["start_handshake"]["released"] = True
        # The bounded handshake is included in, never added to, this command's
        # original outer bound. Native driver/IPC/close deadlines stay unchanged.
        app.wait(timeout=remaining)
        require(app.returncode == 0, f"Command exited {app.returncode}: {name}")
        # A wrapper can exit before its already-observed servers finish.
        # Join those identities and their pipes within the ORIGINAL command
        # deadline, before emergency cleanup decides whether signals are needed.
        audit.wait_for_exit(started + timeout)
        for capture in captures:
            capture.thread.join(timeout=max(0, started + timeout - time.monotonic()))
            require(
                not capture.thread.is_alive() and not capture.error,
                capture.error or "Command log pipe exceeded the command bound",
            )
        require(
            time.monotonic() <= started + timeout,
            "Command completion exceeded its bound",
        )
        audit.check()
        record["natural_exit_joined"] = True
        record["status"] = "passed"
    except ERRORS as error:
        failure(record, f"{type(error).__name__}: {error}")
    finally:
        previous = {
            number: signal.signal(number, signal.SIG_IGN)
            for number in (signal.SIGINT, signal.SIGTERM)
        }
        try:
            if app is not None:
                # Preserve the actual Popen owner even if an interrupt arrived
                # before the immediate post-spawn receipt assignments.
                record["pid"] = app.pid
                record["spawned"] = True
            for descriptor in (read_start, write_start):
                if descriptor is not None:
                    os.close(descriptor)
            if audit:
                audit.finished.set()
                audit.thread.join(timeout=1)
                record["process_audit_joined"] = not audit.thread.is_alive()
                if audit.thread.is_alive() or audit.error:
                    failure(record, audit.error or "Process audit did not join")
                record["processes"] = {
                    "observed_identities": audit.snapshot(),
                    "changes": audit.changes,
                    "maximum_native_hosts": audit.max_hosts,
                    "scope": "Identity-checked observed processes; sampling cannot prove absence between samples",
                }
            if app:
                record["cleanup"] = (
                    DRIVER.cleanup(app, audit.snapshot())
                    if audit
                    else PROCESS.join_unobserved_child(app)
                )
                if record["cleanup"]["forced_termination"]:
                    failure(
                        record,
                        "Command required forced cleanup or lacks joined process evidence",
                    )
            for capture in captures:
                capture.thread.join(timeout=1)
                if capture.thread.is_alive() or capture.error:
                    failure(record, capture.error or "Command log pipe did not join")
                record.setdefault("logs", {})[capture.path.name] = {
                    "written_bytes": capture.written,
                    "discarded_bytes": capture.discarded,
                    **(digest(capture.path) if capture.path.exists() else {}),
                }
            record["log_readers_joined"] = all(
                not capture.thread.is_alive() for capture in captures
            )
            if app:
                for capture in captures:
                    # Closing a buffered pipe while its reader is blocked can
                    # itself block. A live reader is a failed, unjoined receipt.
                    if not capture.thread.is_alive():
                        capture.stream.close()
                if not joined(record):
                    failure(record, "Command ownership or log pipes did not join")
        except ERRORS as error:
            failure(record, f"Cleanup: {type(error).__name__}: {error}")
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
        record["elapsed_seconds"] = time.monotonic() - started
        if time.monotonic() > deadline:
            failure(record, "Fixed phase budget expired during command finalization")
        save(output, report)
    require(
        record["status"] == "passed", record.get("error", f"Command failed: {name}")
    )
    return record


def environment(output, bun):
    env = os.environ.copy()
    for name in (
        "NODE_PATH",
        "BUN_INSTALL",
        "BUN_NATIVE_HOST",
        "NODE_OPTIONS",
        "BUN_OPTIONS",
        "BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR",
    ):
        env.pop(name, None)
    tools = output / "sentinels"
    env.update(
        {
            "PATH": os.pathsep.join([str(tools), str(bun.parent), env.get("PATH", "")]),
            "BUN_INSTALL_CACHE_DIR": str(output / "owned/cache"),
            "BUN_NATIVE_SENTINEL_LOG": str(output / "sentinel-invocations.log"),
            "BUN_NATIVE_HOST_PROFILE": "release",
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
        }
    )
    env.update(
        {name.upper(): str(tools / name) for name in ("cargo", "rustc", "rustup")}
    )
    return env


def invariant(output, report):
    require(
        LOCAL.source_snapshot(ROOT) == report["source"], "Qualification source changed"
    )
    for name in ("bun", "host"):
        TEMPLATES.require_artifact(Path(report[name]["path"]), report[name])
    for name, expected in report["sentinels"].items():
        TEMPLATES.require_artifact(output / "sentinels" / name, expected)
    require(
        not (output / "sentinel-invocations.log").exists(),
        "A Cargo/Rust sentinel was invoked",
    )
    if "package_set" in report:
        TEMPLATES.require_artifact(
            output / "packages/manifest.json", report["package_set"]["manifest"]
        )
        packages = json.loads((output / "packages/manifest.json").read_text())
        require(packages["source"] == report["source"], "Final package source differs")
        for package in packages["packages"].values():
            TEMPLATES.require_artifact(
                output / "packages" / package["archive"]["file"], package["archive"]
            )


def remove_owned(output, report):
    owned = output / "owned"
    if owned.exists():
        require(
            not owned.is_symlink() and owned.resolve() == owned,
            "Owned root was replaced",
        )
        marker = owned / "ownership.json"
        require(
            not marker.is_symlink()
            and json.loads(marker.read_text()) == report["ownership"],
            "Cannot remove a root without its original exclusive ownership marker",
        )
        require(
            all(joined(item) for item in report["commands"]),
            "Cannot remove consumers with unverified command descendants",
        )
        shutil.rmtree(owned)
    report["owned_directory_removed"] = not owned.exists()
    require(
        report["owned_directory_removed"], "Owned consumer root remains after cleanup"
    )


def expected_inputs(project, case, packages):
    LOCAL.installed_inventory(project, packages)
    for name, expected in case["inputs"].items():
        path = (project / name).resolve(strict=True)
        require(path.is_relative_to(project), f"Consumer input escapes: {name}")
        TEMPLATES.require_artifact(path, expected)


def prepare(args):
    started = time.monotonic()
    deadline = started + 590  # Reserve final cleanup within the new ten-minute guard.
    output = args.output.parent.resolve(strict=True) / args.output.name
    source = LOCAL.source_snapshot(ROOT)
    require(
        source["commit"] == args.source_commit and source["tree"] == args.source_tree,
        "Hosted preparation must use its declared exact source",
    )
    require(
        platform.system() == "Linux" and platform.machine() == "x86_64",
        "Hosted consumers require Linux x64",
    )
    bun, host, cache = (
        value.resolve(strict=True) for value in (args.bun, args.host, args.cache)
    )
    require(digest(bun) == LOCAL.BUN_DIGEST, "Pinned Bun executable bytes differ")
    for line in LOCAL.git(ROOT, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            require(
                not output.is_relative_to(Path(line[9:]).resolve()),
                "Consumers must be outside every checkout",
            )
    require(not output.is_relative_to(cache), "Output must be outside the source cache")
    host_record = args.host_sha256_file.resolve(strict=True).read_text().split()
    require(
        len(host_record) == 2
        and len(host_record[0]) == 64
        and (ROOT / host_record[1]).resolve(strict=True) == host
        and digest(host)["sha256"] == host_record[0],
        "Host differs from this job's build fingerprint",
    )
    output.mkdir()
    for name in ("owned", "logs", "sentinels", "sources", "receipts", "native"):
        (output / name).mkdir()
    (output / "owned/projects").mkdir()
    (output / "owned/neutral").mkdir()
    for name in ("cargo", "rustc", "rustup"):
        path = output / "sentinels" / name
        path.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$BUN_NATIVE_SENTINEL_LOG"\nexit 99\n'
        )
        path.chmod(0o755)
    report = {
        "schema_version": 1,
        "status": "preparing",
        "source": source,
        "bun": {"path": str(bun), **digest(bun)},
        "host": {"path": str(host), **digest(host)},
        "ownership": {
            "directory": str(output / "owned"),
            "token": secrets.token_hex(16),
        },
        "host_build_record": {
            "path": str(args.host_sha256_file.resolve()),
            **digest(args.host_sha256_file),
        },
        "planned": PLANNED,
        "commands": [],
        "cases": {
            name: {
                "status": "not-run",
                "native": {mode: {"status": "not-run"} for mode in MODES},
            }
            for name in TEMPLATES.CASES
        },
        "sentinels": {
            name: digest(output / "sentinels" / name)
            for name in ("cargo", "rustc", "rustup")
        },
        "limits": [
            "Hosted Linux software rendering only; no physical GPU, watch, other desktop platform or long-soak qualification",
            "At most eight native cases, stopped at the first unexpected failure; later cases remain not-run",
            "Local negative/cache-relocation cohort is separate and is not repeated here",
        ],
    }
    LOCAL.write_json(output / "owned/ownership.json", report["ownership"])
    save(output, report)
    active = None
    try:
        DRIVER.enable_subreaper()
        cache_before = LOCAL.inventory(cache)
        for name, value in cache_before.items():
            if "link" in value:
                require(
                    (cache / name).resolve(strict=True).is_relative_to(cache),
                    "Package cache link escapes",
                )
        shutil.copytree(cache, output / "owned/cache", symlinks=False)
        copied_cache = LOCAL.inventory(output / "owned/cache")
        require(
            not any("link" in value for value in copied_cache.values()),
            "Owned cache retains links",
        )
        LOCAL.write_json(output / "receipts/cache-before.json", copied_cache)
        report["cache"] = {
            "policy": "Copied existing pinned package cache; offline installs, not a cold/network claim",
            "inventory": digest(output / "receipts/cache-before.json"),
        }
        env = environment(output, bun)
        neutral = output / "owned/neutral"
        inspector = neutral / "inspect.ts"
        shutil.copyfile(
            ROOT / "scripts/quality/standalone-package-inspect.ts", inspector
        )
        run_owned(
            report,
            output,
            "package-set",
            [
                bun,
                "--no-install",
                ROOT / "scripts/package-native.ts",
                "--outdir",
                output / "packages",
            ],
            neutral,
            env,
            240,
            deadline,
        )
        packages = json.loads((output / "packages/manifest.json").read_text())
        require(packages["source"] == source, "Produced package source differs")
        require(
            LOCAL.inventory(output / "packages/cli")
            == packages["packages"]["@bun-native/cli"]["files"],
            "Bootstrap CLI inventory differs",
        )
        pack_records = [
            json.loads(path.read_text())
            for path in sorted((output / "packages/logs").glob("*.json"))
        ]
        require(
            len(pack_records) == 7
            and all(
                item["exitCode"] == 0 and not item["signal"] for item in pack_records
            ),
            "Seven successful actual pack calls are required",
        )
        report["package_set"] = {
            "manifest": digest(output / "packages/manifest.json"),
            "pack_records": pack_records,
        }
        bootstrap = output / "packages/cli/src/scripts/native.ts"
        for name in TEMPLATES.CASES:
            framework, language = name.split("-")
            project = output / "owned/projects" / name
            case = report["cases"][name]
            active = case
            case["status"] = "preparing"
            run_owned(
                report,
                output,
                "create-" + name,
                [
                    bun,
                    "--no-install",
                    bootstrap,
                    "create",
                    project,
                    "--packages",
                    output / "packages/manifest.json",
                    "--framework",
                    framework,
                    "--language",
                    language,
                ],
                neutral,
                env,
                60,
                deadline,
            )
            generated = LOCAL.inventory(project)
            retained = output / "sources" / name
            shutil.copytree(project, retained)
            case.update(status="created", generated=generated)
            run_owned(
                report,
                output,
                "install-" + name,
                [
                    bun,
                    "install",
                    "--offline",
                    "--ignore-scripts",
                    "--linker",
                    "hoisted",
                    "--backend",
                    "copyfile",
                ],
                project,
                env,
                60,
                deadline,
            )
            installed = LOCAL.installed_inventory(project, packages)
            run_owned(
                report,
                output,
                "check-" + name,
                [bun, "--no-install", "run", "check"],
                project,
                env,
                60,
                deadline,
            )
            # The installed CLI's pinned oxlint; vendored archives are never linted.
            run_owned(
                report,
                output,
                "lint-" + name,
                [bun, "--no-install", "run", "lint"],
                project,
                env,
                60,
                deadline,
            )
            run_owned(
                report,
                output,
                "imports-" + name,
                [bun, "--no-install", inspector, project, "imports"],
                neutral,
                env,
                60,
                deadline,
            )
            imported = json.loads(
                (output / "logs" / f"imports-{name}.stdout.log").read_text()
            )
            require(
                imported["status"] == "passed"
                and imported["mode"] == "imports"
                and imported["framework"] == framework
                and len(imported["requiredPackages"]) == 6
                and imported["imports"]
                and imported["source"]
                == {key: source[key] for key in ("commit", "tree")},
                "Installed import/source receipt differs",
            )
            cli = project / "node_modules/@bun-native/cli/src/scripts/native.ts"
            run_owned(
                report,
                output,
                "build-" + name,
                [
                    bun,
                    "--no-install",
                    cli,
                    "build",
                    project,
                    "--host",
                    host,
                    "--host-profile",
                    "release",
                ],
                neutral,
                env,
                150,
                deadline,
            )
            receipt = output / "receipts" / name
            receipt.mkdir()
            case["build_diagnostics"] = {
                "directory": f"receipts/{name}/aot-build-diagnostics",
                "files": EVIDENCE.retain_build_diagnostics(
                    project, receipt / "aot-build-diagnostics"
                ),
            }
            build = EVIDENCE.build_receipt(
                project,
                {key: source[key] for key in ("commit", "tree")},
                packages["toolchain"],
                {key: report["host"][key] for key in ("bytes", "sha256")},
                bun,
            )
            # Build receipt expects only the actual host digest, never a path or the old local study host.
            case.update(
                status="prepared", installed=installed, imports=imported, build=build
            )
            inputs = {key: digest(project / key) for key in generated}
            for key, expected in generated.items():
                if key != "bun.lock":
                    require(
                        inputs[key] == expected,
                        f"Generated consumer changed: {name}/{key}",
                    )
            for package_name in imported["requiredPackages"]:
                for file, expected in packages["packages"][package_name][
                    "files"
                ].items():
                    inputs[f"node_modules/{package_name}/{file}"] = expected
            inputs.update(build["mapped_sources"])
            case["inputs"] = dict(sorted(inputs.items()))
            shutil.copyfile(project / "bun.lock", receipt / "bun.lock")
            shutil.copyfile(project / "dist/manifest.json", receipt / "manifest.json")
            shutil.copytree(project / "dist/development", receipt / "aot-development")
            invariant(output, report)
            save(output, report)
        for prefix in (
            "create-",
            "install-",
            "check-",
            "lint-",
            "imports-",
            "build-",
        ):
            require(
                sum(item["name"].startswith(prefix) for item in report["commands"])
                == 4,
                f"Fixed count differs: {prefix}",
            )
        require(
            all(
                item["processes"]["maximum_native_hosts"] == 0
                for item in report["commands"]
            ),
            "Preparation unexpectedly launched the native host",
        )
        invariant(output, report)
        report["status"] = "prepared"
    except ERRORS as error:
        failure(report, f"{type(error).__name__}: {error}")
        if active is not None:
            failure(active, report["error"])
    finally:
        try:
            invariant(output, report)
        except ERRORS as error:
            failure(report, f"Final invariance: {error}")
        report["preparation_seconds"] = time.monotonic() - started
        if report["preparation_seconds"] > 590:
            failure(report, "Fixed preparation budget expired")
        if report["status"] != "prepared":
            try:
                remove_owned(output, report)
            except ERRORS as error:
                failure(report, f"Cleanup: {error}")
        save(output, report)
    return report


def native_cases(args):
    started = time.monotonic()
    deadline = started + 350  # Reserve final cleanup within the new six-minute guard.
    output = args.output.resolve(strict=True)
    report = json.loads((output / "result.json").read_text())
    require(report["status"] == "prepared", "Only an untouched prepared cohort may run")
    report["status"] = "running"
    save(output, report)
    active = None
    try:
        DRIVER.enable_subreaper()
        invariant(output, report)
        bun, host = Path(report["bun"]["path"]), Path(report["host"]["path"])
        env = environment(output, bun)
        packages = json.loads((output / "packages/manifest.json").read_text())
        TEMPLATES.require_artifact(
            output / "packages/manifest.json", report["package_set"]["manifest"]
        )
        owner = ROOT / "tests/native/cli-standalone-owner.ts"
        for name in TEMPLATES.CASES:
            project = output / "owned/projects" / name
            case = report["cases"][name]
            framework = name.split("-")[0]
            for mode in MODES:
                active = case["native"][mode]
                active["status"] = "checking-inputs"
                active["evidence"] = f"native/{name}/{mode}"
                save(output, report)
                expected_inputs(project, case, packages)
                manifest = case["build"]["manifest"]
                for field in ("application", "developmentModule", "host"):
                    TEMPLATES.require_artifact(
                        project / "dist" / manifest[field]["file"], manifest[field]
                    )
                evidence = output / "native" / name / mode
                evidence.parent.mkdir(parents=True, exist_ok=True)
                executable = project / "dist" / manifest["application"]["file"]
                native_host = (
                    host
                    if mode == "development"
                    else project / "dist" / manifest["host"]["file"]
                )
                command = [
                    str(bun),
                    "--no-install",
                    str(owner),
                    "--report",
                    str(evidence / "lifecycle.json"),
                    "--project",
                    str(project),
                    "--host",
                    str(native_host),
                    "--mode",
                    mode,
                ]
                if mode == "aot":
                    command += ["--executable", str(executable)]
                for path in [
                    bun,
                    native_host,
                    executable,
                    owner,
                    project / "dist/manifest.json",
                    *[project / key for key in case["inputs"]],
                ]:
                    command += ["--artifact", str(path)]
                driver = TEMPLATES.counter_command(framework, mode, evidence, command)
                launch = [
                    "xvfb-run",
                    "--auto-servernum",
                    "--server-args=-screen 0 1280x800x24 -nolisten tcp",
                    "dbus-run-session",
                    "--",
                    "bash",
                    ROOT / "scripts/quality/native-linux-session.sh",
                    str(evidence) + "-session",
                    "--",
                    *driver,
                ]
                active["status"] = "starting"
                record = run_owned(
                    report,
                    output,
                    f"native-{name}-{mode}",
                    launch,
                    output / "owned/neutral",
                    env,
                    45,
                    deadline,
                    native_host=native_host,
                )
                native = json.loads((evidence / "result.json").read_text())
                lifecycle = json.loads((evidence / "lifecycle.json").read_text())
                require(
                    native["status"] == lifecycle["status"] == "passed",
                    "Native/IPC receipt did not pass",
                )
                if mode == "development":
                    require(
                        lifecycle["development_module_removed"] is True,
                        "Installed CLI temporary module remains",
                    )
                    case["development_sources"] = EVIDENCE.source_map_receipt(
                        project,
                        evidence / "native-dev-module/application.js.map",
                        original_directory=Path(
                            lifecycle["development_module"]["directory"]
                        ),
                    )
                expected_inputs(project, case, packages)
                invariant(output, report)
                case["native"][mode] = {
                    "status": "passed",
                    "result": digest(evidence / "result.json"),
                    "lifecycle": digest(evidence / "lifecycle.json"),
                    "command": record["name"],
                }
                save(output, report)
            case["status"] = "passed"
        require(
            sum(item["name"].startswith("native-") for item in report["commands"]) == 8,
            "Eight native cases were not completed",
        )
        report["status"] = "passed"
    except ERRORS as error:
        failure(report, f"{type(error).__name__}: {error}")
        if active is not None:
            failure(active, report["error"])
    finally:
        try:
            invariant(output, report)
        except ERRORS as error:
            failure(report, f"Final invariance: {error}")
        try:
            remove_owned(output, report)
        except ERRORS as error:
            failure(report, f"Cleanup: {error}")
        report["native_seconds"] = time.monotonic() - started
        if report["native_seconds"] > 360:
            failure(report, "Fixed native matrix budget expired")
        save(output, report)
    return report


def finalize(args):
    output = args.output.resolve()
    if not (output / "result.json").exists():
        return {"status": "not-run"}
    report = json.loads((output / "result.json").read_text())
    if report["status"] not in ("passed", "failed"):
        failure(
            report, "Qualification did not reach a terminal result before final cleanup"
        )
    try:
        invariant(output, report)
    except ERRORS as error:
        failure(report, f"Final invariance: {error}")
    try:
        remove_owned(output, report)
    except ERRORS as error:
        failure(report, f"Cleanup: {error}")
    save(output, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    build = actions.add_parser("prepare")
    run = actions.add_parser("run")
    cleanup = actions.add_parser("cleanup")
    for command in (build, run, cleanup):
        command.add_argument("--output", type=Path, required=True)
    for name in ("bun", "host", "cache", "host-sha256-file"):
        build.add_argument("--" + name, type=Path, required=True)
    for name in ("source-commit", "source-tree"):
        build.add_argument("--" + name, required=True)
    args = parser.parse_args()
    require(args.output.is_absolute(), "Output must be absolute")

    def interrupted(number, _frame):
        raise InterruptedError(f"Hosted cohort interrupted by signal {number}")

    original = {
        number: signal.signal(number, interrupted)
        for number in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        report = {"prepare": prepare, "run": native_cases, "cleanup": finalize}[
            args.action
        ](args)
    finally:
        for number, handler in original.items():
            signal.signal(number, handler)
    print(json.dumps({"status": report["status"], "output": str(args.output)}))
    return 0 if report["status"] in ("prepared", "passed", "not-run") else 1
