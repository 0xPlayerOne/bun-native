#!/usr/bin/env python3
"""Qualify unchanged checkout CLI templates with one owned X11 scenario.

Preparation uses the actual create/check/build commands. Run replaces itself
with the existing input supervisor; its Bun IPC owner runs the exact dev command
or inspected AOT app without inserting an application callback.
"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
CASES = [
    f"{framework}-{language}"
    for framework in ("solid", "react")
    for language in ("typescript", "javascript")
]


def artifact(path):
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"bytes": path.stat().st_size, "sha256": digest}


def source_identity():
    def git(*arguments):
        return subprocess.check_output(
            ["git", *arguments], cwd=REPOSITORY, timeout=10
        ).decode()

    return {
        "commit": git("rev-parse", "HEAD").strip(),
        "dirty": bool(git("status", "--porcelain")),
        "files": [
            {"path": path, **artifact(REPOSITORY / path)}
            for path in sorted(git("ls-files", "-z").split("\0"))
            if path
        ],
    }


def run_logged(command, log, cwd):
    with log.open("xb") as stream:
        completed = subprocess.run(
            command,
            cwd=cwd,
            stdout=stream,
            stderr=subprocess.STDOUT,
            timeout=150,
            check=False,
        )
    if completed.returncode != 0:
        raise RuntimeError(f"Command exited {completed.returncode}; see {log}")


def require_artifact(path, expected):
    if artifact(path) != {key: expected[key] for key in ("bytes", "sha256")}:
        raise RuntimeError(f"Artifact identity changed: {path}")


def prepare(output, host, bun):
    """Compile once per template; retain the exact generated source for dev too."""
    output.mkdir(parents=True, exist_ok=False)
    source = source_identity()
    pin = json.loads((REPOSITORY / "toolchain.json").read_text())
    revision = (
        subprocess.check_output([str(bun), "--print", "Bun.revision"], timeout=10)
        .decode()
        .strip()
    )
    if revision != pin["bun"]["revision"]:
        raise RuntimeError("Use the pinned Bun compiler")
    provenance = {
        "schema_version": 1,
        "source": source,
        "platform": {
            "os": sys.platform,
            "machine": platform.machine(),
            "release": platform.release(),
        },
        "compiler": {"path": str(bun), "revision": revision, **artifact(bun)},
        "host": {"path": str(host), "profile": "release", **artifact(host)},
        "toolchain": pin,
        "verification_scope": "Prepared source and inspected AOT; native qualification is recorded separately for each mode",
        "cases": {},
    }
    cache = REPOSITORY / ".bun-native"
    cache.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cli-native-", dir=cache) as directory:
        for case in CASES:
            framework, language = case.split("-", 1)
            destination = output / case
            destination.mkdir()
            project = Path(directory) / case
            package = destination / "package"
            cli = [str(bun), str(REPOSITORY / "scripts/native.ts")]
            commands = [
                [
                    *cli,
                    "create",
                    str(project),
                    "--framework",
                    framework,
                    "--language",
                    language,
                ],
                [str(bun), "run", "check"],
                [
                    *cli,
                    "build",
                    str(project),
                    "--host",
                    str(host),
                    "--host-profile",
                    "release",
                    "--outdir",
                    str(package),
                ],
            ]
            for name, command in zip(
                ("create", "check", "build"), commands, strict=True
            ):
                run_logged(
                    command,
                    destination / f"{name}.log",
                    project if name == "check" else REPOSITORY,
                )
            shutil.copytree(project, destination / "source")
            manifest = json.loads((package / "manifest.json").read_text())
            if (
                manifest["framework"] != framework
                or manifest["toolchain"] != pin
                or manifest["application"]["inspection"]["hasCompiledProgram"]
                is not True
                or manifest["application"]["runtimeFeatures"]["jit"] == "present"
                or manifest["application"]["runtimeFeatures"]["jitRemovedRanges"][
                    "count"
                ]
                < 1
                or manifest["host"]["profile"] != "release"
                or manifest["host"]["sha256"] != provenance["host"]["sha256"]
            ):
                raise RuntimeError(
                    f"Package does not bind the pinned AOT compiler and release host: {case}"
                )
            for key in ("application", "developmentModule", "host"):
                require_artifact(package / manifest[key]["file"], manifest[key])
            provenance["cases"][case] = {
                "framework": framework,
                "language": language,
                "commands": commands,
                "source": [
                    {"path": path.name, **artifact(path)}
                    for path in sorted(project.iterdir())
                    if path.is_file()
                ],
                "manifest": artifact(package / "manifest.json"),
            }
    require_artifact(host, provenance["host"])
    require_artifact(bun, provenance["compiler"])
    if source_identity() != source:
        raise RuntimeError("Repository source changed while preparing the templates")
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")


def counter_paint(framework, count):
    """Independent full-tree oracle for both unchanged TS/JS template variants."""
    elements = [
        {"kind": "box", "style": {}},
        {"kind": "box", "style": {}},
        {"kind": "box", "style": {"direction": "column", "gap": 12, "padding": 24}},
        {
            "kind": "text",
            "text": f"Bun Native {framework.title()}",
            "style": {"font_size": 28},
        },
        {"kind": "text", "text": f"Clicks: {count}", "style": {}},
        {
            "kind": "button",
            "text": "Increment",
            "disabled": False,
            "style": {"width": 160, "height": 44},
        },
    ]
    return {
        "type": "rendered",
        "stage": "native-paint",
        "window_id": 1,
        "tree_revision": count + 1,
        "nodes": [
            {
                "node_id": index,
                "element": element,
                "children": {1: [2], 2: [3], 3: [4, 5, 6]}.get(index, []),
            }
            for index, element in enumerate(elements, 1)
        ],
    }


def scenario(package_root, case, mode, output):
    provenance_path = package_root / "provenance.json"
    provenance = json.loads(provenance_path.read_text())
    prepared = provenance["cases"][case]
    framework = prepared["framework"]
    bun = Path(provenance["compiler"]["path"])
    host = Path(provenance["host"]["path"])
    package = package_root / case / "package"
    require_artifact(bun, provenance["compiler"])
    require_artifact(host, provenance["host"])
    require_artifact(package / "manifest.json", prepared["manifest"])
    for item in prepared["source"]:
        require_artifact(package_root / case / "source" / item["path"], item)
    if source_identity() != provenance["source"]:
        raise RuntimeError("Qualification source differs from package preparation")
    manifest = json.loads((package / "manifest.json").read_text())
    for key in ("application", "developmentModule", "host"):
        require_artifact(package / manifest[key]["file"], manifest[key])
    executable = package / manifest["application"]["file"]
    os.environ["BUN_NATIVE_HOST_PROFILE"] = "release"
    os.environ.pop("BUN_NATIVE_HOST", None)
    if mode == "development":
        owner = REPOSITORY / "tests/native/cli-dev-owner.ts"
        command = []
    else:
        # Exercise adjacent-host resolution in the actual compiled launcher.
        host = package / manifest["host"]["file"]
        command = [str(executable)]
        owner = REPOSITORY / "tests/native/cli-template-owner.ts"
    owned = [str(bun), str(owner), "--report", str(output / "lifecycle.json")]
    for path in [
        bun,
        host,
        *([executable] if mode == "aot" else []),
        provenance_path,
        package / "manifest.json",
        owner,
    ]:
        owned += ["--artifact", str(path)]
    if mode == "development":
        owned += [
            "--source",
            str(package_root / case / "source"),
            "--host",
            str(host),
        ]
    driver = REPOSITORY / "scripts/quality/native-input-linux.py"
    return [
        sys.executable,
        str(driver),
        "--output",
        str(output),
        "--mode",
        mode,
        "--title",
        f"Bun Native {framework.title()}",
        "--timeout",
        "30",
        "--expect-software-renderer",
        "--expect-native-pointer",
        "--require-unforced-cleanup",
        "--click",
        "100",
        "130",
        "--expect-initial-render",
        json.dumps(counter_paint(framework, 0)),
        "--expect-render",
        json.dumps(counter_paint(framework, 1)),
        "--",
        *owned,
        *(["--", *command] if command else []),
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    build = subparsers.add_parser("prepare")
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--host", type=Path, required=True)
    build.add_argument("--bun", type=Path, required=True)
    run = subparsers.add_parser("run")
    run.add_argument("--packages", type=Path, required=True)
    run.add_argument("--case", choices=CASES, required=True)
    run.add_argument("--mode", choices=["development", "aot"], required=True)
    run.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(
            args.output.resolve(),
            args.host.resolve(strict=True),
            args.bun.resolve(strict=True),
        )
    else:
        command = scenario(
            args.packages.resolve(), args.case, args.mode, args.output.resolve()
        )
        os.execv(sys.executable, command)


if __name__ == "__main__":
    main()
