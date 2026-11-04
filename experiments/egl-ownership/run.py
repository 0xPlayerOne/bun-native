"""Exercise actual pinned WGPU ownership paths through an owned fake EGL ABI."""

import argparse
import hashlib
import io
import json
import os
import resource
import shutil
import subprocess
import tarfile
from pathlib import Path

PIN = "cddb2f5d80dc0009b2ef6767635140cacf90a007"
EGL_PATH = "wgpu-hal/src/gles/egl.rs"
EGL_SHA256 = "2663a1da95a05dc6f0ce33f1479934cf7a67736973dc353c3ac90073260e865b"
EXPERIMENT = Path(__file__).resolve().parent
CASES = (
    "initialize-failure",
    "vendor-failure",
    "extensions-failure",
    "config-failure",
    "client-apis-failure",
    "bind-api-failure",
    "context-failure",
    "pbuffer-failure",
    "success",
    "shared-initialize-failure",
    "shared-vendor-failure",
    "shared-pbuffer-lifetime",
)
EGL_PROBE = """
#[cfg(feature = "bun-native-egl-ownership-probe")]
#[path = "bun-native-egl-ownership-probe.rs"]
mod bun_native_egl_ownership_probe;
#[cfg(feature = "bun-native-egl-ownership-probe")]
pub use self::bun_native_egl_ownership_probe::run_bun_native_egl_ownership_probe;
"""
MANIFEST = """[package]
name = "bun-native-egl-ownership-probe"
version = "0.0.0"
edition = "2021"
publish = false

[workspace]

[dependencies]
wgpu-hal = { path = "../wgpu/wgpu-hal", default-features = false, features = ["gles", "bun-native-egl-ownership-probe"] }
"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args, *, cwd, env, log, timeout=120):
    result = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    log.with_suffix(".stdout").write_text(result.stdout)
    log.with_suffix(".stderr").write_text(result.stderr)
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited {result.returncode}; see {log}.stderr")
    return result.stdout


def prepare(source, output, variant, env):
    archive = subprocess.run(
        ["git", "-C", str(source), "archive", "--format=tar", PIN],
        capture_output=True,
        check=True,
        timeout=30,
    ).stdout
    wgpu = output / "wgpu"
    wgpu.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as snapshot:
        snapshot.extractall(wgpu, filter="data")
    egl = wgpu / EGL_PATH
    if digest(egl) != EGL_SHA256:
        raise RuntimeError("pinned EGL source hash mismatch")
    patches = [] if variant == "baseline" else ["construction-rollback.patch"]
    if variant == "complete-ownership":
        patches.append("pbuffer-owner-release.patch")
    for patch in patches:
        command(
            [
                "git",
                "apply",
                str(EXPERIMENT / patch),
            ],
            cwd=wgpu,
            env=env,
            log=output / patch,
        )
    ownership_source_sha256 = digest(egl)
    manifest = wgpu / "wgpu-hal/Cargo.toml"
    manifest.write_text(
        manifest.read_text().replace(
            "[features]\n", "[features]\nbun-native-egl-ownership-probe = []\n", 1
        )
    )
    egl.write_text(egl.read_text() + EGL_PROBE)
    module = egl.with_name("mod.rs")
    module.write_text(
        module.read_text()
        + '\n#[cfg(feature = "bun-native-egl-ownership-probe")]\n'
        + "pub use self::egl::run_bun_native_egl_ownership_probe;\n"
    )
    shutil.copyfile(
        EXPERIMENT / "ownership-probe.rs",
        egl.with_name("bun-native-egl-ownership-probe.rs"),
    )
    runner = output / "runner"
    (runner / "src").mkdir(parents=True)
    (runner / "Cargo.toml").write_text(MANIFEST)
    shutil.copyfile(EXPERIMENT / "main.rs", runner / "src/main.rs")
    shutil.copyfile(EXPERIMENT / "Cargo.lock", runner / "Cargo.lock")
    return ownership_source_sha256


def expected_assertion(variant, case):
    if case == "shared-pbuffer-lifetime" and variant != "complete-ownership":
        return "dropped owner's pbuffer released"
    if variant != "baseline" or case == "success":
        return None
    if case.startswith("shared-"):
        return "failed attempt preserves prior ownership"
    return "failed construction leaves no display reference"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, required=True, help="read-only WGPU git checkout"
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="new owned output directory"
    )
    parser.add_argument(
        "--variant",
        choices=("baseline", "construction-rollback", "complete-ownership"),
        required=True,
    )
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    env = dict(
        os.environ,
        CARGO_TARGET_DIR=str(output / "target"),
        CARGO_BUILD_JOBS="2",
        RUSTUP_TOOLCHAIN="1.98.1",
        RUST_BACKTRACE="0",
        RUSTFLAGS=f"--remap-path-prefix={output}=/private-egl-experiment",
    )
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    ownership_source = prepare(source, output, args.variant, env)
    rust = command(["rustc", "-Vv"], cwd=output, env=env, log=output / "rust-version")
    if "release: 1.98.1\n" not in rust:
        raise RuntimeError("expected pinned Rust 1.98.1")
    compiler = command(
        ["cc", "--version"], cwd=output, env=env, log=output / "cc-version"
    )
    fixture = output / "libfake-egl.so"
    command(
        [
            "cc",
            "-shared",
            "-fPIC",
            "-std=c11",
            "-Wall",
            "-Werror",
            str(EXPERIMENT / "fake-egl.c"),
            "-o",
            str(fixture),
        ],
        cwd=output,
        env=env,
        log=output / "fixture-build",
    )
    command(
        [
            "cargo",
            "build",
            "--offline",
            "--locked",
            "--manifest-path",
            "runner/Cargo.toml",
        ],
        cwd=output,
        env=env,
        log=output / "build",
    )
    binary = output / "target/debug/bun-native-egl-ownership-probe"
    records = []
    for case in CASES:
        result = subprocess.run(
            [str(binary), str(fixture), case],
            check=False,
            cwd=output,
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        (output / f"{case}.stdout").write_text(result.stdout)
        (output / f"{case}.stderr").write_text(result.stderr)
        assertion = expected_assertion(args.variant, case)
        expected = (
            result.returncode == 101 and assertion in result.stderr
            if assertion
            else result.returncode == 0 and f"case-passed {case}\n" in result.stdout
        )
        records.append(
            {
                "case": case,
                "exit_code": result.returncode,
                "expected_assertion": assertion,
                "matches_expected_outcome": expected,
                "snapshots": [
                    json.loads(line[9:])
                    for line in result.stdout.splitlines()
                    if line.startswith("snapshot ")
                ],
                "calls": [
                    line[9:]
                    for line in result.stdout.splitlines()
                    if line.startswith("egl-call ")
                ],
                "stdout_sha256": hashlib.sha256(result.stdout.encode()).hexdigest(),
                "stderr_sha256": hashlib.sha256(result.stderr.encode()).hexdigest(),
            }
        )
    report = {
        "scope": "actual pinned constructor/drop, fake EGL ABI; no driver, GPU or window",
        "variant": args.variant,
        "wgpu_commit": PIN,
        "pristine_egl_sha256": EGL_SHA256,
        "ownership_source_sha256": ownership_source,
        "compiled_egl_sha256": digest(output / "wgpu" / EGL_PATH),
        "experiment_sha256": {
            p.name: digest(p)
            for p in sorted(EXPERIMENT.iterdir())
            if p.is_file() and p.suffix in (".py", ".rs", ".c", ".patch", ".lock")
        },
        "binary_sha256": digest(binary),
        "fixture_sha256": digest(fixture),
        "rust": rust.strip(),
        "c_compiler": compiler.splitlines()[0],
        "cases": records,
        "matches_expected_outcomes": all(
            row["matches_expected_outcome"] for row in records
        ),
    }
    (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "variant": args.variant,
                "matches_expected_outcomes": report["matches_expected_outcomes"],
                "case_exit_codes": [row["exit_code"] for row in records],
            }
        )
    )
    if not report["matches_expected_outcomes"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
