"""Execute the fixed #382 local-package cohort once; no application is launched."""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import stat
import struct
import subprocess
import time
from pathlib import Path

BUN_REVISION = "da867c60bf0bcbf9d6d36994f8ca0efa42075115"
BUN_DIGEST = {
    "bytes": 138468432,
    "sha256": "fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810",
}
HOST_DIGEST = {
    "bytes": 29478384,
    "sha256": "55ad891864636ab1e4c11ad4dd9973552f294ecce2adf7e1e39479f79aaeac9b",
}
CASES = (
    ("solid", "typescript"),
    ("solid", "javascript"),
    ("react", "typescript"),
    ("react", "javascript"),
)
NEGATIVES = (
    "missing-archive",
    "changed-archive",
    "escaping-archive",
    "escaping-entry",
    "changed-installed-source",
    "omitted-host",
    "foreign-os",
    "wrong-cpu",
)
COHORT_ERRORS = (
    OSError,
    RuntimeError,
    ValueError,
    KeyError,
    TypeError,
    subprocess.SubprocessError,
    KeyboardInterrupt,
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    result = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            result.update(chunk)
    return {"bytes": size, "sha256": result.hexdigest()}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def missing_registry_cache_failure(exit_code, stderr, packages):
    """A cache negative must not hide an invalid-lock fallback or another error."""
    message = re.sub(r"\x1b\[[0-9;]*m", "", stderr)
    if exit_code != 1 or "InvalidLockfile" in message or "Ignoring lockfile" in message:
        return False
    identities = {entry[0] for entry in packages.values()}
    names = {identity.rsplit("@", 1)[0] for identity in identities}
    missing = set()
    resolutions = []
    for line in message.splitlines():
        if not line.startswith("error:"):
            continue
        match = re.fullmatch(
            r'error: --offline: no cached manifest for "([^"]+)" \(run once online, or use --prefer-offline\)',
            line,
        )
        if match and match[1] in names:
            missing.add(match[1])
            continue
        match = re.fullmatch(r'error: --offline: "([^"]+)" is not in the cache', line)
        if match and match[1] in names:
            missing.add(match[1])
            continue
        match = re.fullmatch(r"error: (\S+) failed to resolve", line)
        if match and match[1] in identities:
            resolutions.append(match[1].rsplit("@", 1)[0])
            continue
        return False
    return bool(missing) and all(name in missing for name in resolutions)


def inventory(directory):
    """Record files and original links without following directory symlinks."""
    result = {}
    for parent, directories, files in os.walk(directory, followlinks=False):
        for name in sorted(directories + files):
            path = Path(parent) / name
            key = path.relative_to(directory).as_posix()
            if path.is_symlink():
                result[key] = {"link": os.readlink(path)}
            elif path.is_file():
                result[key] = digest(path)
            else:
                require(path.is_dir(), f"Unsupported inventory entry: {path}")
    return dict(sorted(result.items()))


def git(repository, *args):
    return subprocess.check_output(
        ["git", "-C", str(repository), *args], timeout=10
    ).decode()


def source_snapshot(repository):
    require(
        not git(repository, "status", "--porcelain", "--untracked-files=all"),
        "Source must be clean",
    )
    paths = git(repository, "ls-files", "-z").split("\0")[:-1]
    files = {}
    for name in sorted(paths):
        path = repository / name
        require(
            stat.S_ISREG(path.lstat().st_mode), f"Source is not a regular file: {name}"
        )
        files[name] = digest(path)
    return {
        "commit": git(repository, "rev-parse", "HEAD").strip(),
        "tree": git(repository, "rev-parse", "HEAD^{tree}").strip(),
        "files": files,
    }


def installed_inventory(project, package_set):
    """Check all present local sources before executing an installed CLI module."""
    modules = (project / "node_modules").resolve(strict=True)
    require(modules.is_relative_to(project), "node_modules escapes the consumer")
    checked = []
    for name, pkg in package_set["packages"].items():
        location = modules / name
        if not location.exists():
            continue  # Overrides do not install the other framework's adapter.
        location = location.resolve(strict=True)
        require(location.is_relative_to(modules), f"Installed package escapes: {name}")
        actual = inventory(location)
        require(actual == pkg["files"], f"Installed package inventory differs: {name}")
        checked.append(name)
    require("@bun-native/cli" in checked, "Installed CLI is missing")
    links = []
    for parent, directories, files in os.walk(modules, followlinks=False):
        for name in directories + files:
            path = Path(parent) / name
            if path.is_symlink():
                require(
                    path.resolve(strict=True).is_relative_to(project),
                    f"Installed link escapes: {path}",
                )
                links.append(
                    {
                        "path": str(path.relative_to(project)),
                        "target": os.readlink(path),
                    }
                )
    return {"validated_local_packages": sorted(checked), "contained_links": links}


class Cohort:
    def __init__(self, arguments):
        self.args = arguments
        self.repository = arguments.repository.resolve(strict=True)
        self.bun = arguments.bun.resolve(strict=True)
        self.host = arguments.host.resolve(strict=True)
        self.cache = arguments.cache.resolve(strict=True)
        require(
            arguments.output.is_absolute(), "Output must be an absolute new directory"
        )
        require(
            platform.system() == "Linux" and platform.machine() == "x86_64",
            "This fixed cohort is Linux x64",
        )
        require(digest(self.bun) == BUN_DIGEST, "Pinned Bun bytes differ")
        require(digest(self.host) == HOST_DIGEST, "Qualified release host bytes differ")
        self.source = source_snapshot(self.repository)
        require(
            self.source["commit"] == arguments.source_commit,
            "Source is not the published predeclared commit",
        )
        require(
            self.source["tree"] == arguments.source_tree,
            "Source tree differs from the reviewed checkpoint",
        )
        self.output = (
            arguments.output.parent.resolve(strict=True) / arguments.output.name
        )
        require(
            not self.output.is_relative_to(self.cache),
            "Output must be outside the source cache to avoid copying into itself",
        )
        for line in git(
            self.repository, "worktree", "list", "--porcelain"
        ).splitlines():
            if line.startswith("worktree "):
                require(
                    not self.output.is_relative_to(Path(line[9:]).resolve()),
                    "Output must be outside every checkout",
                )
        self.output.mkdir()  # Never adopt an existing result directory.
        self.commands = []
        self.report = {
            "schemaVersion": 1,
            "status": "running",
            "source": {"commit": self.source["commit"], "tree": self.source["tree"]},
            "toolchain": {
                "revision": BUN_REVISION,
                "bun": BUN_DIGEST,
                "host": HOST_DIGEST,
            },
            "system": platform.platform(),
            "planned": {
                "package_calls": 7,
                "consumer_installs": 9,
                "checks": 4,
                "public_import_smokes": 4,
                "aot_builds": 4,
                "invalid_inputs": list(NEGATIVES),
            },
            "commands": self.commands,
            "cases": {
                f"{framework}-{language}": {"status": "not-run"}
                for framework, language in CASES
            },
            "negative_controls": {name: {"status": "not-run"} for name in NEGATIVES},
            "limits": [
                "No application/native execution",
                "No watch or GC workload",
                "One fail-stop cohort, with unattempted later operations remaining not-run",
                "Direct command children are joined; no post-exit descendant discovery or native process-tree claim",
            ],
        }
        self.env = os.environ.copy()
        for name in (
            "NODE_PATH",
            "BUN_INSTALL",
            "BUN_NATIVE_HOST",
            "BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR",
            "NODE_OPTIONS",
            "BUN_OPTIONS",
        ):
            self.env.pop(name, None)
        for name in (
            "neutral",
            "logs",
            "sentinels",
            "cache",
            "original",
            "relocated with spaces",
            "negatives",
        ):
            (self.output / name).mkdir()
        self.sentinel_log = self.output / "sentinel-invocations.log"
        for name in ("cargo", "rustc", "rustup"):
            path = self.output / "sentinels" / name
            path.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$BUN_NATIVE_SENTINEL_LOG"\nexit 99\n'
            )
            path.chmod(0o755)
        self.env.update(
            {
                "PATH": str(self.output / "sentinels")
                + os.pathsep
                + str(self.bun.parent)
                + os.pathsep
                + self.env["PATH"],
                "BUN_NATIVE_SENTINEL_LOG": str(self.sentinel_log),
                "NO_COLOR": "1",
                "FORCE_COLOR": "0",
            }
        )
        self.inspector = self.output / "neutral" / "inspect.ts"
        shutil.copyfile(
            self.repository / "scripts/quality/standalone-package-inspect.ts",
            self.inspector,
        )
        write_json(self.output / "source-before.json", self.source)
        self.report["harness"] = {
            name: digest(self.repository / "scripts/quality" / name)
            for name in ("standalone-packages.py", "standalone-package-inspect.ts")
        }
        self.started = None
        self.packages = None
        self.save()

    def save(self):
        write_json(self.output / "result.json", self.report)

    def run(self, name, argv, *, cwd=None, timeout=60, cache=None):
        remaining = 900 - (time.monotonic() - self.started)
        require(
            remaining >= timeout,
            f"Insufficient whole-cohort budget for the full {timeout}-second command bound: {name}",
        )
        stdout = self.output / "logs" / (name + ".stdout.log")
        stderr = self.output / "logs" / (name + ".stderr.log")
        env = {
            **self.env,
            "BUN_INSTALL_CACHE_DIR": str(cache or self.output / "cache/populated"),
        }
        record = {
            "name": name,
            "argv": list(map(str, argv)),
            "cwd": str(cwd or self.output / "neutral"),
            "timeout_seconds": timeout,
            "status": "running",
            "direct_child_joined": False,
            "forced_termination": False,
            "descendant_cleanup_verified": False,
        }
        self.commands.append(record)
        start = time.monotonic()
        with stdout.open("xb") as out, stderr.open("xb") as err:
            child = subprocess.Popen(
                record["argv"],
                cwd=record["cwd"],
                env=env,
                stdout=out,
                stderr=err,
                start_new_session=True,
            )
            record["pid"] = child.pid
            try:
                child.wait(timeout=timeout)
            except (
                subprocess.TimeoutExpired,
                InterruptedError,
                KeyboardInterrupt,
            ) as error:
                record["wait_error"] = f"{type(error).__name__}: {error}"
                record["forced_termination"] = True
            finally:
                # Popen owns this direct child. Never discover or signal new
                # descendants/process groups after the root may have exited.
                for stop, bound in ((child.terminate, 5), (child.kill, 2)):
                    if child.poll() is not None:
                        break
                    record["forced_termination"] = True
                    try:
                        stop()
                        child.wait(timeout=bound)
                    except (OSError, subprocess.TimeoutExpired) as error:
                        record.setdefault("join_errors", []).append(str(error))
                record.update(
                    {
                        "exit_code": child.returncode,
                        "direct_child_joined": child.returncode is not None,
                        "elapsed_seconds": time.monotonic() - start,
                    }
                )
        record.update(
            {
                "stdout": digest(stdout),
                "stderr": digest(stderr),
                "status": "exited" if record["direct_child_joined"] else "unjoined",
            }
        )
        self.save()
        require(
            not record["forced_termination"] and record["direct_child_joined"],
            f"Command required forced or incomplete joining: {name}; {record.get('wait_error', '')}",
        )
        require(
            not self.sentinel_log.exists(),
            f"Native toolchain sentinel was invoked: {name}",
        )
        return record, stdout, stderr

    def success(self, name, argv, **options):
        record, stdout, stderr = self.run(name, argv, **options)
        require(
            record["exit_code"] == 0, f"Command failed: {name}; see retained stderr"
        )
        return record, stdout, stderr

    def install(self, name, project, *, frozen=False, cache=None):
        command = [
            self.bun,
            "install",
            "--offline",
            "--ignore-scripts",
            "--linker",
            "hoisted",
            "--backend",
            "copyfile",
        ]
        if frozen:
            command.append("--frozen-lockfile")
        return self.run(name, command, cwd=project, cache=cache)

    def inspect(self, name, project, mode):
        files = installed_inventory(project, self.packages)
        _, stdout, _ = self.success(
            name, [self.bun, "--no-install", self.inspector, project, mode]
        )
        receipt = json.loads(stdout.read_text())
        require(
            receipt["status"] == "passed"
            and receipt["source"] == self.report["source"],
            "Inspector source/result mismatch",
        )
        shutil.copyfile(
            project / "bun.lock", self.output / "logs" / (name + ".bun.lock")
        )
        return {
            "installed": files,
            "receipt": receipt,
            "lock": digest(project / "bun.lock"),
        }

    def scaffold_receipt(self, project):
        result = inventory(project)
        for name in ("package.json", "bun-native.json", "tsconfig.json", "README.md"):
            text = (project / name).read_text()
            require(
                str(self.repository) not in text and str(self.output) not in text,
                f"Generated file embeds a checkout/producer path: {name}",
            )
        config = json.loads((project / "tsconfig.json").read_text())
        require(
            "extends" not in config, "Consumer depends on another TypeScript config"
        )
        shutil.copyfile(
            project / "bun.lock",
            self.output / "logs" / ("create-" + project.name + ".bun.lock"),
        )
        return result

    def prepare_cache(self):
        before = inventory(self.cache)
        links = {name: value for name, value in before.items() if "link" in value}
        for name in links:
            path = self.cache / name
            require(
                path.resolve(strict=True).is_relative_to(self.cache),
                f"Cache link escapes: {name}",
            )
        started = time.monotonic()
        shutil.copytree(self.cache, self.output / "cache/populated", symlinks=False)
        populated = inventory(self.output / "cache/populated")
        require(
            not any("link" in value for value in populated.values()),
            "Copied cache unexpectedly retains links",
        )
        (self.output / "cache/empty").mkdir()
        write_json(self.output / "cache-before.json", populated)
        self.report["cache_copy"] = {
            "source_links": links,
            "policy": "Dereference contained source-cache links into the task-owned copy",
            "copy_elapsed_seconds": time.monotonic() - started,
            "inventory": digest(self.output / "cache-before.json"),
        }

    def build_receipt(self, project):
        directory = project / "dist"
        manifest = json.loads((directory / "manifest.json").read_text())
        require(
            manifest["packageSet"]["source"] == self.report["source"],
            "AOT source identity differs",
        )
        require(
            manifest["packageSet"]["manifest"]
            == digest(project / "vendor/bun-native/manifest.json"),
            "AOT package-set identity differs",
        )
        require(
            manifest["toolchain"] == self.packages["toolchain"], "AOT toolchain differs"
        )
        require(
            manifest["application"]["inspection"]["hasCompiledProgram"],
            "Compiled-program record missing",
        )
        runtime = manifest["application"]["runtimeFeatures"]
        require(
            runtime["jit"] != "present" and runtime["jitRemovedRanges"]["count"] > 0,
            "JIT omission evidence missing",
        )
        command = manifest["application"]["compileCommand"]
        require(
            command[:3] == [str(self.bun), "--no-install", "compile"],
            "AOT child lost its explicit no-install guard",
        )
        for field in ("application", "developmentModule", "host"):
            item = manifest[field]
            require(
                digest(directory / item["file"])
                == {key: item[key] for key in ("bytes", "sha256")},
                f"AOT {field} bytes differ",
            )
        require(
            digest(directory / manifest["host"]["file"]) == HOST_DIGEST,
            "Bundled host differs",
        )
        require(
            all(
                manifest["verification"][key] == "not-run"
                for key in ("nativeRendering", "osInput", "teardown")
            ),
            "Build overstates native qualification",
        )
        source_map = directory / "development/application.js.map"
        mapping = json.loads(source_map.read_text())
        require(
            mapping["version"] == 3 and mapping["sources"], "Missing source-map inputs"
        )
        sources = {}
        for name in mapping["sources"]:
            target = (source_map.parent / mapping.get("sourceRoot", "") / name).resolve(
                strict=True
            )
            require(
                target.is_relative_to(project) and target.is_file(),
                f"Source-map input escapes consumer: {name}",
            )
            sources[target.relative_to(project).as_posix()] = digest(target)
        return {
            "manifest": manifest,
            "manifest_digest": digest(directory / "manifest.json"),
            "source_map": digest(source_map),
            "mapped_sources": sources,
            "source_map_limit": "No original Solid TSX line/column fidelity claim",
        }

    def negative(self, name, solid):
        root = self.output / "negatives" / name
        root.mkdir()
        project = root / "project"
        output = root / "unexpected-output"
        bootstrap = self.output / "packages/cli/src/scripts/native.ts"
        if name in NEGATIVES[:3]:
            local_set = root / "set"
            shutil.copytree(self.output / "packages", local_set)
            manifest = json.loads((local_set / "manifest.json").read_text())
            archive = (
                local_set / manifest["packages"]["@bun-native/core"]["archive"]["file"]
            )
            if name == "missing-archive":
                archive.unlink()
                expected = "ENOENT"
            elif name == "changed-archive":
                with archive.open("ab") as stream:
                    stream.write(b"changed archive bytes")
                expected = "archive digest mismatch"
            else:
                manifest["packages"]["@bun-native/core"]["archive"]["file"] = (
                    "../outside.tgz"
                )
                write_json(local_set / "manifest.json", manifest)
                expected = "unique contained relative paths"
            argv = [
                self.bun,
                "--no-install",
                bootstrap,
                "create",
                project,
                "--packages",
                local_set / "manifest.json",
            ]
        else:
            shutil.copytree(solid, project, ignore=shutil.ignore_patterns("dist"))
            cli = project / "node_modules/@bun-native/cli/src/scripts/native.ts"
            argv = [
                self.bun,
                "--no-install",
                cli,
                "build",
                project,
                "--outdir",
                output,
                "--host-profile",
                "release",
            ]
            host = self.host
            if name == "escaping-entry":
                config = json.loads((project / "bun-native.json").read_text())
                config["entry"] = "../outside.ts"
                write_json(project / "bun-native.json", config)
                (root / "outside.ts").write_text(
                    "throw new Error('invalid-entry-executed')\n"
                )
                expected = "Project entry must be a source file inside the project"
            elif name == "changed-installed-source":
                core = project / "node_modules/@bun-native/core/src/index.ts"
                with core.open("a") as stream:
                    stream.write("\nthrow new Error('invalid-package-executed')\n")
                expected = "Installed package digest mismatch"
            elif name == "omitted-host":
                host = None
                expected = "--host must be an absolute path"
            else:
                host = root / "guard-input"
                header = bytearray(64)
                if name == "foreign-os":
                    struct.pack_into("<II", header, 0, 0xFEEDFACF, 0x01000007)
                else:
                    struct.pack_into("<I", header, 0, 0x464C457F)
                    header[4:6] = b"\x02\x01"
                    struct.pack_into("<H", header, 18, 183)
                host.write_bytes(header)
                host.chmod(0o755)
                expected = "Prebuilt host must be a linux/x64 executable"
            if host is not None:
                argv += ["--host", host]
        record, _, stderr = self.run("negative-" + name, argv)
        message = stderr.read_text()
        require(
            record["exit_code"] != 0 and expected in message,
            f"Wrong invalid-input outcome: {name}",
        )
        require(
            not output.exists()
            and not (project / "dist").exists()
            and not (project / ".bun-native").exists(),
            f"Invalid input created build output: {name}",
        )
        if name in NEGATIVES[:3]:
            require(
                not project.exists(), f"Invalid package set created its project: {name}"
            )
        require(
            "invalid-entry-executed" not in message
            and "invalid-package-executed" not in message,
            "Invalid source was executed",
        )
        self.report["negative_controls"][name] = {
            "status": "passed",
            "expected_error": expected,
            "exit_code": record["exit_code"],
        }
        self.save()

    def execute(self):
        self.prepare_cache()
        self.started = time.monotonic()
        self.success(
            "package-set",
            [
                self.bun,
                "--no-install",
                self.repository / "scripts/package-native.ts",
                "--outdir",
                self.output / "packages",
            ],
            timeout=240,
        )
        self.packages = json.loads((self.output / "packages/manifest.json").read_text())
        require(
            self.packages["source"] == self.source, "Produced package source differs"
        )
        require(
            inventory(self.output / "packages/cli")
            == self.packages["packages"]["@bun-native/cli"]["files"],
            "Bootstrap CLI inventory differs",
        )
        self.report["package_set"] = {
            "manifest": digest(self.output / "packages/manifest.json"),
            "archives": {
                name: value["archive"]
                for name, value in self.packages["packages"].items()
            },
            "pack_records": [
                json.loads(path.read_text())
                for path in sorted((self.output / "packages/logs").glob("*.json"))
            ],
        }
        bootstrap = self.output / "packages/cli/src/scripts/native.ts"
        for framework, language in CASES:
            name = framework + "-" + language
            project = self.output / "original" / name
            self.success(
                "create-" + name,
                [
                    self.bun,
                    "--no-install",
                    bootstrap,
                    "create",
                    project,
                    "--packages",
                    self.output / "packages/manifest.json",
                    "--framework",
                    framework,
                    "--language",
                    language,
                ],
            )
            self.report["cases"][name] = {
                "status": "created",
                "generated": self.scaffold_receipt(project),
            }
        for framework, language in CASES:
            name = framework + "-" + language
            project = self.output / "original" / name
            case = self.report["cases"][name]
            if name == "solid-typescript":
                original_lock = (project / "bun.lock").read_bytes()
                record, _, stderr = self.install(
                    "install-empty-cache", project, cache=self.output / "cache/empty"
                )
                registry_packages = self.packages["consumers"][framework]["lock"][
                    "packages"
                ]
                require(
                    missing_registry_cache_failure(
                        record["exit_code"], stderr.read_text(), registry_packages
                    ),
                    "Empty-cache outcome was not exclusively missing pinned registry packages",
                )
                case["empty_cache_control"] = {
                    "status": "passed",
                    "exit_code": record["exit_code"],
                    "lock_after_attempt": digest(project / "bun.lock")
                    if (project / "bun.lock").exists()
                    else None,
                }
                if (project / "bun.lock").exists():
                    shutil.copyfile(
                        project / "bun.lock",
                        self.output / "logs/install-empty-cache.bun.lock",
                    )
                for path in (project / "node_modules", project / "bun.lockb"):
                    if path.is_dir():
                        shutil.rmtree(path)
                    elif path.exists():
                        path.unlink()
                (project / "bun.lock").write_bytes(original_lock)
            record, _, _ = self.install("install-first-" + name, project)
            require(
                record["exit_code"] == 0, f"Initial consumer install failed: {name}"
            )
            case["initial"] = self.inspect("lock-first-" + name, project, "lock")
            case["status"] = "installed"
        for framework, language in CASES:
            name = framework + "-" + language
            project = self.output / "original" / name
            case = self.report["cases"][name]
            relocated = self.output / "relocated with spaces" / name
            project.rename(relocated)
            shutil.rmtree(relocated / "node_modules")
            before_lock = digest(relocated / "bun.lock")
            record, _, _ = self.install(
                "install-frozen-" + name, relocated, frozen=True
            )
            require(
                record["exit_code"] == 0, f"Relocated frozen install failed: {name}"
            )
            require(
                digest(relocated / "bun.lock") == before_lock,
                "Frozen reinstall changed the consumer lock",
            )
            self.success(
                "check-" + name,
                [self.bun, "--no-install", "run", "check"],
                cwd=relocated,
            )
            case["relocated"] = self.inspect("imports-" + name, relocated, "imports")
            cli = relocated / "node_modules/@bun-native/cli/src/scripts/native.ts"
            self.success(
                "build-" + name,
                [
                    self.bun,
                    "--no-install",
                    cli,
                    "build",
                    relocated,
                    "--host",
                    self.host,
                    "--host-profile",
                    "release",
                ],
                timeout=150,
            )
            case["build"] = self.build_receipt(relocated)
            for path, expected in case["generated"].items():
                if path != "bun.lock":
                    require(
                        digest(relocated / path) == expected,
                        f"Generated source changed during qualification: {name}/{path}",
                    )
            case["status"] = "passed"
            self.save()
        solid = self.output / "relocated with spaces/solid-typescript"
        for name in NEGATIVES:
            self.negative(name, solid)
        require(
            len([item for item in self.commands if item["name"].startswith("install-")])
            == 9,
            "Install count differs",
        )
        require(
            len([item for item in self.commands if item["name"].startswith("build-")])
            == 4,
            "AOT build count differs",
        )
        require(
            len(list((self.output / "packages/logs").glob("*.json"))) == 7,
            "Pack count differs",
        )
        for prefix in ("check-", "imports-"):
            require(
                sum(item["name"].startswith(prefix) for item in self.commands) == 4,
                f"Command count differs: {prefix}",
            )
        require(
            all(
                value["status"] == "passed"
                for value in self.report["negative_controls"].values()
            ),
            "Invalid-input cohort incomplete",
        )
        self.report["status"] = "passed"

    def finish(self):
        final = source_snapshot(self.repository)
        write_json(self.output / "source-after.json", final)
        self.report["invariance"] = {
            "source": final == self.source,
            "bun": digest(self.bun) == BUN_DIGEST,
            "host": digest(self.host) == HOST_DIGEST,
            "sentinels_unused": not self.sentinel_log.exists(),
            "all_direct_children_joined": all(
                item["direct_child_joined"] for item in self.commands
            ),
        }
        require(
            all(self.report["invariance"].values()),
            "Final source/tool/ownership invariance failed",
        )
        self.report["elapsed_seconds_excluding_cache_copy"] = (
            None if self.started is None else time.monotonic() - self.started
        )
        if self.report["status"] == "passed":
            require(
                self.report["elapsed_seconds_excluding_cache_copy"] <= 900,
                "Fixed whole-cohort budget exceeded",
            )
        self.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("repository", "bun", "host", "cache", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-tree", required=True)
    cohort = Cohort(parser.parse_args())

    def interrupted(signum, _frame):
        raise InterruptedError(f"Cohort interrupted by signal {signum}")

    original_handlers = {
        number: signal.signal(number, interrupted)
        for number in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        cohort.execute()
    except COHORT_ERRORS as error:
        cohort.report.update(
            {"status": "failed", "error": f"{type(error).__name__}: {error}"}
        )
    finally:
        try:
            cohort.finish()
        except COHORT_ERRORS as error:
            cohort.report["status"] = "failed"
            cohort.report.setdefault("error", f"{type(error).__name__}: {error}")
            cohort.report.setdefault("finalization_errors", []).append(str(error))
            cohort.save()
        finally:
            for number, handler in original_handlers.items():
                signal.signal(number, handler)
    print(
        json.dumps(
            {
                "status": cohort.report["status"],
                "output": str(cohort.output),
                "commands": len(cohort.commands),
            }
        )
    )
    return 0 if cohort.report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
