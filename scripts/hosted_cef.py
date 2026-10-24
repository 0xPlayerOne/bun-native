"""Bounded native qualification on disposable GitHub runners, never a release publisher."""

import argparse
import ctypes
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / ".bunly/hosted-evidence"
SUITES = ("smoke", "rpc", "full")


def target(system=None, machine=None):
    system = system or sys.platform
    machine = (machine or platform.machine()).lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine)
    value = f"{system}-{arch}"
    if value not in ("win32-x64", "linux-x64", "darwin-arm64"):
        raise ValueError("Unsupported hosted native target")
    return value


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def write(name, value):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / name).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def artifact():
    bundle = (ROOT / ".bunly/cef-bundle").resolve(strict=True)
    path = Path(json.loads((bundle / "bundle.json").read_text())["path"]).resolve(strict=True)
    if not path.is_relative_to(bundle):
        raise ValueError("Assembled artifact escapes the private bundle")
    return path


def layout(path):
    app = path if sys.platform == "darwin" else path.parent
    resources = app / ("Contents/Resources" if sys.platform == "darwin" else "resources")
    library = (
        app
        / {
            "darwin": "Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
            "win32": "libcef.dll",
            "linux": "libcef.so",
        }[sys.platform]
    )
    return app, resources, library


def prepare():
    app, resources, _ = layout(artifact())
    shutil.copytree(ROOT / "native/cef-host/resources", resources, dirs_exist_ok=True)
    if sys.platform == "darwin":
        from qualify_adhoc_signing import targets

        for entry in targets(app):
            subprocess.run(
                ["/usr/bin/codesign", "--force", "--sign", "-", str(entry)],
                check=True,
                capture_output=True,
                timeout=30,
            )
        subprocess.run(
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
            check=True,
            capture_output=True,
            timeout=30,
        )
    print(json.dumps({"prepared": True, "target": target(), "productionSigning": False}))


def standard_user():
    if sys.platform == "win32":
        return ctypes.windll.shell32.IsUserAnAdmin() == 0
    return os.geteuid() != 0


def commands(suite, bun, app):
    if suite not in SUITES:
        raise ValueError("Unknown qualification suite")
    # The RPC suite wraps the same prebuilt matrix and additionally rejects
    # missing real renderer/native protocol evidence. It writes the same report
    # family; a generic successful smoke report cannot satisfy its exit status.
    entrypoint = "qualify-cef-rpc.ts" if suite == "rpc" else "qualify-cef-prebuilt.ts"
    result = [("prebuilt", [bun, str(ROOT / "scripts" / entrypoint), str(app)])]
    if suite in ("rpc", "full"):
        result.append(
            ("development", [bun, str(ROOT / "scripts/qualify-cef-development.ts"), str(app)])
        )
        result.append(("network", [bun, str(ROOT / "scripts/qualify-cef-network.ts"), str(app)]))
        result.append(
            (
                "transports",
                [
                    bun,
                    str(ROOT / "scripts/qualify-cef-transports.ts"),
                    str(app),
                    "--functional",
                ],
            )
        )
    if suite == "rpc":
        result.append(
            ("session-reset", [bun, str(ROOT / "scripts/qualify-cef-session-reset.ts"), str(app)])
        )
    if suite == "full":
        result += [
            (
                "faults",
                [
                    sys.executable,
                    str(ROOT / "scripts/qualify-cef-faults.py"),
                    str(app),
                    "--bun",
                    bun,
                ],
            ),
        ]
    return result


def execute(name, args, timeout=600):
    destination = EVIDENCE / (name + ".log")
    with destination.open("w", encoding="utf-8") as output:
        try:
            child = subprocess.run(
                args, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, timeout=timeout
            )
            return child.returncode
        except subprocess.TimeoutExpired:
            output.write("\nHOSTED_QUALIFICATION_COMMAND_TIMEOUT\n")
            return 124


def new_report(name, before):
    directory = ROOT / ".bunly/m3" / name
    candidates = set(directory.glob("run-*/report.json")) - before
    if len(candidates) != 1:
        raise ValueError("Missing or ambiguous fresh " + name + " report")
    path = candidates.pop()
    if path.is_symlink() or path.stat().st_size > 128 * 1024**2:
        raise ValueError("Invalid qualification report")
    return json.loads(path.read_text(encoding="utf-8"))


def run(suite):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    result = {"schema": 1, "suite": suite, "target": target(), "passed": False, "steps": []}
    reports = {}
    try:
        if not standard_user():
            raise ValueError("Native acceptance must run without administrator/root privileges")
        if os.environ.get("EXPECTED_TARGET") != target():
            raise ValueError("Actual architecture differs from the selected runner")
        bun = (
            str(Path(os.environ["BUNLY_HOSTED_BUN"]).resolve(strict=True))
            if os.environ.get("BUNLY_HOSTED_BUN")
            else shutil.which("bun")
        )
        if not bun:
            raise ValueError("Pinned Bun executable is missing")
        version = subprocess.check_output([bun, "--version"], text=True, timeout=10).strip()
        if version != "1.4.3":
            raise ValueError("Unexpected Bun version")
        source = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=10
        ).strip()
        clean = not subprocess.check_output(
            ["git", "status", "--porcelain"], cwd=ROOT, text=True, timeout=10
        ).strip()
        if not re.fullmatch(r"[a-f0-9]{40}", source) or not clean:
            raise ValueError("Qualification requires a clean pinned checkout")
        result.update(sourceCommit=source, sourceClean=clean)
        environment = {
            "target": target(),
            "os": platform.platform(),
            "machine": platform.machine(),
            "standardUser": True,
            "emulated": False,
            "bunVersion": version,
            "python": platform.python_version(),
            "runnerImage": os.environ.get("ImageVersion"),  # noqa: SIM112 -- GitHub-defined spelling
            "runClass": "ci-smoke",
            "display": os.environ.get("DISPLAY", "hosted-desktop-unqualified"),
        }
        reports["environment"] = environment
        write("environment.json", environment)
        os.environ["PYTHON"] = sys.executable
        os.environ["BUNLY_BENCH_SANDBOX"] = "1"
        app = artifact()
        _, _, library = layout(app)
        code = execute(
            "identity",
            [
                sys.executable,
                str(ROOT / "scripts/probe_cef_identity.py"),
                "--library",
                str(library),
                "--sha256",
                digest(library),
            ],
            60,
        )
        if code:
            raise ValueError("Actual native browser identity probe failed")
        identity = json.loads((EVIDENCE / "identity.log").read_text().strip())
        reports["identity"] = identity
        write("identity.json", identity)
        for name, args in commands(suite, bun, app):
            before = set((ROOT / ".bunly/m3" / name).glob("run-*/report.json"))
            code = execute(name, args)
            row = {"name": name, "exitCode": code, "passed": False}
            result["steps"].append(row)
            try:
                report = new_report(name, before)
                reports[name] = report
                write(name + ".json", report)
                row["passed"] = code == 0 and report.get("passed") is True
            except (OSError, ValueError) as error:
                row["failure"] = str(error)
            print(json.dumps(row), flush=True)
        if not all(step["passed"] for step in result["steps"]):
            raise ValueError("Native qualification failed; see per-scenario diagnostics")
        if suite == "full" and sys.platform != "darwin":
            from report_m3_platform import validate

            result["acceptance"] = validate(
                target(), "standard", reports, expected_identity=("156.0.7", "156.0.8078.17")
            )
        result["passed"] = True
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        result["failure"] = str(error)
    finally:
        write("qualification.json", result)
        print(json.dumps(result), flush=True)
    return 0 if result["passed"] else 1


def collect():
    """Export only explicit diagnostics, never private fixtures, caches, or key files."""
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    for directory in (
        ROOT / ".bunly/m3/prebuilt",
        ROOT / ".bunly/m3/development",
        ROOT / ".bunly/m3/network",
        ROOT / ".bunly/m3/transports",
        ROOT / ".bunly/m3/session-reset",
        ROOT / ".bunly/m3/faults",
    ):
        for path in directory.glob("run-*/report.json"):
            if not path.is_symlink() and path.stat().st_size <= 128 * 1024**2:
                write(
                    directory.name + "-" + path.parent.name + ".json", json.loads(path.read_text())
                )
    # Private test nonces are not production secrets, but do not publish them.
    for path in EVIDENCE.iterdir():
        if path.suffix not in (".json", ".log") or path.is_symlink() or not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        text = re.sub(r"(?<![a-fA-F0-9])[a-fA-F0-9]{48}(?![a-fA-F0-9])", "[fixture-nonce]", text)
        path.write_text(text, encoding="utf-8")
    summary = EVIDENCE / "qualification.json"
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write("## Native qualification\n\n")
            output.write(
                "```json\n" + summary.read_text() + "```\n"
                if summary.exists()
                else "No native result was produced. Check setup/build logs; portable-only runs do not claim native acceptance.\n"
            )
    print("Qualification diagnostics collected; no runtime or credentials uploaded.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "run", "collect"))
    parser.add_argument("--suite", choices=SUITES, default="full")
    options = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("This entrypoint is restricted to disposable GitHub Actions jobs")
    if options.action == "prepare":
        prepare()
    elif options.action == "run":
        raise SystemExit(run(options.suite))
    else:
        collect()
