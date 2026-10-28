"""Bounded native qualification on disposable GitHub runners, never a release publisher."""

import argparse
import base64
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

from export_native_evidence import NONCE, sanitize_report

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / ".bunly/hosted-evidence"
SUITES = ("smoke", "rpc", "full", "credentials", "m4-acceptance")


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
    manifest = json.loads((bundle / "bundle.json").read_text(encoding="utf-8"))
    path = Path(manifest["path"]).resolve(strict=True)
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


def validated_native_target_directory(value):
    if (
        not value
        or len(value) > 4096
        or "\n" in value
        or "\r" in value
        or "\0" in value
        or not Path(value).is_absolute()
    ):
        raise ValueError("Invalid native Cargo artifact directory")
    return Path(value)


def native_target_directory(bun, selected=None):
    # Windows resolves metadata in the build account before launching its
    # standard-user worker, which intentionally has no compiler or Cargo home.
    # An explicit handoff is authoritative; never probe a second/default tree.
    if selected is not None:
        return validated_native_target_directory(selected)
    # Native-only jobs install the CEF compiler, not the repository's older M1
    # default. Metadata must use that installed toolchain instead of implicitly
    # fetching M1's toolchain. Preserve an explicit contributor selection.
    environment = dict(os.environ)
    environment.setdefault("RUSTUP_TOOLCHAIN", "1.91.0")
    result = subprocess.run(
        [
            bun,
            str(ROOT / "scripts/cargo.ts"),
            "--print-target-dir",
            "--manifest-path",
            str(ROOT / "native/cef-host/Cargo.toml"),
        ],
        cwd=ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=15,
    )
    return validated_native_target_directory(result.stdout.removesuffix("\n"))


def commands(suite, bun, app, native_source=None):
    if suite not in SUITES:
        raise ValueError("Unknown qualification suite")
    if native_source is not None and not re.fullmatch(r"[a-f0-9]{40}", native_source):
        raise ValueError("Native source must be an immutable commit")
    if suite == "credentials":
        return [("credentials", [bun, str(ROOT / "scripts/qualify-cef-credentials.ts"), str(app)])]
    # The RPC suite wraps the same prebuilt matrix and additionally rejects
    # missing real renderer/native protocol evidence. It writes the same report
    # family; a generic successful smoke report cannot satisfy its exit status.
    entrypoint = (
        "qualify-cef-rpc.ts"
        if suite in ("rpc", "m4-acceptance", "full")
        else "qualify-cef-prebuilt.ts"
    )
    result = [("prebuilt", [bun, str(ROOT / "scripts" / entrypoint), str(app)])]
    if suite in ("rpc", "m4-acceptance", "full"):
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
    if suite in ("rpc", "m4-acceptance", "full"):
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
    if suite == "full":
        desktop = (
            [
                sys.executable,
                str(ROOT / "scripts/qualify-cef-window-modes-linux.py"),
                "--disposable-runner",
                "--desktop",
                "--bun",
                bun,
                str(app),
            ]
            if sys.platform == "linux"
            else [bun, str(ROOT / "scripts/qualify-desktop.ts"), str(app)]
        )
        if native_source is not None:
            desktop.append("--native-source=" + native_source)
        result.append(("desktop", desktop))
        composition = [*desktop]
        composition.append(
            "--desktop-case=composition" if sys.platform == "linux" else "--case=composition"
        )
        result.append(("view-composition", composition))
        services = [*desktop]
        services.append("--desktop-case=services" if sys.platform == "linux" else "--case=services")
        if sys.platform != "linux":
            services.append("--disposable-clipboard")
        result.append(("desktop-services", services))
        downloads = [*desktop]
        downloads.append(
            "--desktop-case=downloads" if sys.platform == "linux" else "--case=downloads"
        )
        result.append(("file-downloads", downloads))
        parent_close = [*desktop]
        parent_close.append(
            "--desktop-case=parent-close" if sys.platform == "linux" else "--case=parent-close"
        )
        result.append(("view-parent-close", parent_close))
        menus = [*desktop]
        menus.append("--desktop-case=commands" if sys.platform == "linux" else "--case=commands")
        result.append(("window-commands", menus))
        # A real window manager is a qualification prerequisite on Linux, not
        # an application dependency or permission to reuse a contributor desktop.
        window = (
            [
                sys.executable,
                str(ROOT / "scripts/qualify-cef-window-modes-linux.py"),
                "--disposable-runner",
                "--bun",
                bun,
                str(app),
            ]
            if sys.platform == "linux"
            else [bun, str(ROOT / "scripts/qualify-cef-window-modes.ts"), str(app)]
        )
        result.append(("window-modes", window))
        result.append(
            (
                "terminals",
                [bun, str(ROOT / "scripts/qualify-cef-terminals.ts"), str(app), "--functional"],
            )
        )
    if suite == "full":
        # Keep real native state and default renderer throttling in the load gate.
        # Linux owns an isolated window manager, never the contributor's desktop.
        load = (
            [
                sys.executable,
                str(ROOT / "scripts/qualify-cef-window-modes-linux.py"),
                "--disposable-runner",
                "--terminal-load",
                "--bun",
                bun,
                str(app),
            ]
            if sys.platform == "linux"
            else [
                bun,
                str(ROOT / "scripts/qualify-terminal-window-load.ts"),
                "cef",
                str(app),
                "--functional",
            ]
        )
        result.append(("terminal-load", load))
        # Listing a plan does not declare build provenance. run() supplies the
        # verified checkout commit; the qualifier rejects an absent declaration.
        managed = [bun, str(ROOT / "scripts/qualify-managed-development.ts"), str(app)]
        if native_source is not None:
            managed.append("--native-source=" + native_source)
        result.append(("managed-development", managed))
    if suite in ("m4-acceptance", "full"):
        result.extend(commands("credentials", bun, app))
    return result


def require_stage_prerequisites(suite, name, steps):
    if name == "credentials" and suite != "credentials":
        expected = [
            stage
            for stage, _ in commands("full" if suite == "full" else "rpc", "bun", Path("app"))
            if stage != "credentials"
        ]
        if [row["name"] for row in steps] != expected or not all(row["passed"] for row in steps):
            raise ValueError(
                "Credential qualification requires every preceding native stage to pass"
            )


def prepare_credential_prerequisites():
    # Installing Secret Service before ordinary tests permits D-Bus activation
    # of an unowned prompting daemon. Keep installation after all ordinary gates,
    # immediately before the explicit fixture starts its isolated provider.
    if sys.platform != "linux":
        return
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
        or not standard_user()
    ):
        raise ValueError("Provider prerequisites require a disposable hosted standard user")
    subprocess.run(
        ["sudo", "apt-get", "install", "-y", "gnome-keyring", "libsecret-tools", "libglib2.0-bin"],
        check=True,
        timeout=180,
    )


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


def report_directory(name):
    if name == "desktop":
        return ROOT / ".bunly/m7/desktop"
    if name == "view-composition":
        return ROOT / ".bunly/m7/view-composition"
    if name == "desktop-services":
        return ROOT / ".bunly/m7/desktop-services"
    if name == "file-downloads":
        return ROOT / ".bunly/m7/file-downloads"
    if name == "view-parent-close":
        return ROOT / ".bunly/m7/view-parent-close"
    if name == "window-commands":
        return ROOT / ".bunly/m7/window-commands"
    if name == "terminals":
        return ROOT / ".bunly/m5/graphical-terminals"
    if name == "window-modes":
        return ROOT / ".bunly/m5/window-modes"
    if name == "terminal-load":
        return ROOT / ".bunly/m5/terminal-load"
    if name == "managed-development":
        return ROOT / ".bunly/m6/managed-development"
    return ROOT / ".bunly/m3" / name


def new_report(name, before):
    directory = report_directory(name)
    candidates = set(directory.glob("run-*/report.json")) - before
    if len(candidates) != 1:
        raise ValueError("Missing or ambiguous fresh " + name + " report")
    path = candidates.pop()
    if path.is_symlink() or path.stat().st_size > 128 * 1024**2:
        raise ValueError("Invalid qualification report")
    return json.loads(path.read_text(encoding="utf-8"))


def run(suite, selected_native_target=None):
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
        if version != "1.4.4":
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
        if suite != "credentials":
            executable_dir = app / "Contents/MacOS" if sys.platform == "darwin" else app.parent
            native_release = native_target_directory(bun, selected_native_target) / "release"
            suffix = ".exe" if sys.platform == "win32" else ""
            code = execute(
                "terminal-owner",
                [
                    sys.executable,
                    str(ROOT / "scripts/qualify_terminal_owner.py"),
                    "--bun",
                    bun,
                    "--owner",
                    str(executable_dir / ("bunly-terminal-owner" + suffix)),
                    "--host",
                    str(native_release / ("bunly-terminal-fixture-host" + suffix)),
                    "--output",
                    str(EVIDENCE / "terminal-owner.json"),
                ],
            )
            owner_report = json.loads(
                (EVIDENCE / "terminal-owner.json").read_text(encoding="utf-8")
            )
            result["terminalOwnership"] = {
                "passed": code == 0 and owner_report.get("passed") is True
            }
            if not result["terminalOwnership"]["passed"]:
                raise ValueError("Actual native terminal ownership qualification failed")
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
        identity = json.loads((EVIDENCE / "identity.log").read_text(encoding="utf-8").strip())
        reports["identity"] = identity
        write("identity.json", identity)
        for name, args in commands(suite, bun, app, native_source=source):
            require_stage_prerequisites(suite, name, result["steps"])
            if name == "credentials":
                prepare_credential_prerequisites()
            before = set(report_directory(name).glob("run-*/report.json"))
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
            from report_m3_platform import REQUIRED, validate

            result["acceptance"] = validate(
                target(),
                "standard",
                {name: reports[name] for name in REQUIRED},
                expected_identity=("156.0.7", "156.0.8078.17"),
            )
        result["passed"] = True
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        result["failure"] = str(error)
    finally:
        write(
            "qualification-credentials.json" if suite == "credentials" else "qualification.json",
            result,
        )
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
        ROOT / ".bunly/m3/credentials",
        ROOT / ".bunly/m3/session-reset",
        ROOT / ".bunly/m3/faults",
        ROOT / ".bunly/m5/graphical-terminals",
        ROOT / ".bunly/m5/window-modes",
        ROOT / ".bunly/m5/terminal-load",
        ROOT / ".bunly/m6/managed-development",
        ROOT / ".bunly/m7/desktop",
        ROOT / ".bunly/m7/view-composition",
        ROOT / ".bunly/m7/desktop-services",
        ROOT / ".bunly/m7/file-downloads",
        ROOT / ".bunly/m7/view-parent-close",
        ROOT / ".bunly/m7/window-commands",
    ):
        for path in directory.glob("run-*/report.json"):
            if not path.is_symlink() and path.stat().st_size <= 128 * 1024**2:
                write(
                    directory.name + "-" + path.parent.name + ".json",
                    json.loads(path.read_text(encoding="utf-8")),
                )
    # Private test nonces are not production secrets, but do not publish them.
    for path in EVIDENCE.iterdir():
        if path.suffix not in (".json", ".log") or path.is_symlink() or not path.is_file():
            continue
        # These are UTF-8 diagnostic files. Undecodable bytes must not be silently
        # replaced and published as if they were the original recorded evidence.
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            text = json.dumps(sanitize_report(json.loads(text)), indent=2) + "\n"
        else:
            text = NONCE.sub("[fixture-nonce]", text)
        path.write_text(text, encoding="utf-8")
    summary = EVIDENCE / "qualification.json"
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write("## Native qualification\n\n")
            output.write(
                "```json\n" + summary.read_text(encoding="utf-8") + "```\n"
                if summary.exists()
                else "No native result was produced. Check setup/build logs; portable-only runs do not claim native acceptance.\n"
            )
    print("Qualification diagnostics collected; no runtime or credentials uploaded.")


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "run", "collect", "target-directory-base64"))
    parser.add_argument("--suite", choices=SUITES, default="full")
    parser.add_argument("--native-target-directory")
    options = parser.parse_args(arguments)
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("This entrypoint is restricted to disposable GitHub Actions jobs")
    if options.native_target_directory is not None and options.action != "run":
        parser.error("--native-target-directory is only valid with run")
    if options.action == "prepare":
        prepare()
    elif options.action == "run":
        raise SystemExit(run(options.suite, options.native_target_directory))
    elif options.action == "target-directory-base64":
        bun = shutil.which("bun")
        if not bun:
            raise SystemExit("Pinned Bun executable is missing")
        # Keep the first Python-to-PowerShell hop ASCII too; a Windows pipe may
        # use a legacy code page before PowerShell sees the selected directory.
        selected = str(native_target_directory(bun)).encode("utf-8")
        print(base64.b64encode(selected).decode("ascii"))
    else:
        collect()


if __name__ == "__main__":
    main()
