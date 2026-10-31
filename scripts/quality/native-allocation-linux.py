#!/usr/bin/env python3
"""Profile the explicit native host during the existing real lifecycle fixture.

Run inside native-linux-session.sh's private Xvfb/DBus session. This is an
instrumented heaptrack diagnostic, never an ordinary performance baseline.
"""

import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_input_linux", ROOT / "scripts/quality/native-input-linux.py"
)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)
MAX_PROFILE_BYTES = 64 * 1024 * 1024


def fingerprint(path):
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"path": str(path), "sha256": digest, "bytes": path.stat().st_size}


def source_snapshot():
    paths = [
        ROOT / name
        for name in (
            "package.json",
            "bun.lock",
            "bunfig.toml",
            "tsconfig.json",
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
            "tests/native/public-lifecycle.ts",
            "examples/native-window/content.ts",
            "scripts/quality/native-input-linux.py",
            "scripts/quality/native-linux-session.sh",
            "scripts/quality/native-allocation-linux.py",
        )
    ]
    for package in ("core", "protocol", "runtime"):
        paths.append(ROOT / "packages" / package / "package.json")
        paths.extend((ROOT / "packages" / package / "src").rglob("*.ts"))
    paths.extend((ROOT / "native").rglob("*.rs"))
    paths.extend((ROOT / "native").rglob("Cargo.toml"))
    return {str(path.relative_to(ROOT)): fingerprint(path) for path in sorted(paths)}


def limit_file_output():
    cap = min(
        [DRIVER.MAX_LOG_BYTES]
        + [
            value
            for value in resource.getrlimit(resource.RLIMIT_FSIZE)
            if value != resource.RLIM_INFINITY
        ]
    )
    resource.setrlimit(resource.RLIMIT_FSIZE, (cap, cap))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def write_host_wrapper(wrapper, host, library, identity, raw_limit):
    wrapper.write_text(
        f"#!{sys.executable}\n"
        "import json, os, resource, signal, sys\n"
        "from pathlib import Path\n"
        f"cap = min([{raw_limit}] + [v for v in resource.getrlimit(resource.RLIMIT_FSIZE) if v != resource.RLIM_INFINITY])\n"
        "resource.setrlimit(resource.RLIMIT_FSIZE, (cap, cap))\n"
        "resource.setrlimit(resource.RLIMIT_CORE, (0, 0))\n"
        # Python ignores SIGXFSZ. execve preserves ignored dispositions; restore
        # the default so a capped trace terminates the host instead of truncating
        # silently while the native workload still reports success.
        "signal.signal(signal.SIGXFSZ, signal.SIG_DFL)\n"
        "started = int(Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19])\n"
        f"with open({str(identity) + '.tmp'!r}, 'x') as stream:\n"
        "    json.dump({'pid': os.getpid(), 'start_ticks': started}, stream)\n"
        f"os.replace({str(identity) + '.tmp'!r}, {str(identity)!r})\n"
        "environment = dict(os.environ)\n"
        f"environment['LD_PRELOAD'] = {str(library)!r}\n"
        f"environment['DUMP_HEAPTRACK_OUTPUT'] = {str(wrapper.parent / 'native.raw')!r}\n"
        f"os.execve({str(host)!r}, [{str(host)!r}, *sys.argv[1:]], environment)\n"
    )
    wrapper.chmod(0o700)


def sample_owned(process, observed):
    rows = DRIVER.owned_processes(process.pid, DRIVER.process_table())
    observed.update({row["pid"]: row["start_ticks"] for row in rows})
    return {row["pid"]: row for row in rows}


def observe_native_process(recorded, owned, host, library):
    pid = recorded["pid"]
    row = owned.get(pid)
    if (
        row is None
        or row["state"] == "Z"
        or row["start_ticks"] != recorded["start_ticks"]
    ):
        return None
    try:
        executable = Path(f"/proc/{pid}/exe").resolve(strict=True)
        mappings = Path(f"/proc/{pid}/maps").read_text().splitlines()
    except OSError:
        # The process can exit between the identity sample and these reads. It
        # supplies no proof; the run still fails if no valid observation exists.
        return None
    if executable != host or not any(
        fields[5] == str(library)
        for line in mappings
        if len(fields := line.split(None, 5)) == 6
    ):
        return None
    return {
        **recorded,
        "executable": str(executable),
        "heaptrackMappingObserved": True,
    }


def cleanup_driver(process, observed):
    # Cancellation can arrive immediately after Popen, before the first loop
    # sample. The Popen child cannot have its PID reused while still running.
    if process.poll() is None:
        sample_owned(process, observed)
    return DRIVER.cleanup(process, observed)


def profile_bytes(output):
    return sum(path.stat().st_size for path in output.iterdir() if path.is_file())


def interrupt(signum, _frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGALRM, signal.SIG_IGN)
    raise InterruptedError(f"Native allocation diagnostic received signal {signum}")


def analyze(output, interpreter, printer, demangler):
    raw = output / "native.raw"
    profile = output / "native.heaptrack.gz"
    child = None
    try:
        with (
            raw.open("rb") as source,
            (output / "interpret.stderr.log").open("wb") as errors,
            gzip.open(profile, "wb") as compressed,
        ):
            child = subprocess.Popen(
                [str(interpreter)],
                stdin=source,
                stdout=subprocess.PIPE,
                stderr=errors,
                preexec_fn=limit_file_output,
            )
            interpreted_bytes = 0
            while chunk := child.stdout.read(64 * 1024):
                interpreted_bytes += len(chunk)
                if interpreted_bytes > 4 * MAX_PROFILE_BYTES:
                    raise RuntimeError("Interpreted trace exceeded its size bound")
                compressed.write(chunk)
                if profile_bytes(output) > MAX_PROFILE_BYTES:
                    raise RuntimeError("Allocation artifacts exceeded 64 MiB")
            if child.wait(timeout=5):
                raise RuntimeError("heaptrack_interpret failed")
    finally:
        if child is not None:
            try:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
            finally:
                if child.stdout is not None:
                    child.stdout.close()
    # The compressed, interpreted trace preserves the allocation events and
    # resolved stacks. Keep the raw trace hash without retaining both copies.
    raw.unlink()
    with (output / "summary.txt").open("wb") as summary:
        subprocess.run(
            [
                str(printer),
                "--file",
                str(profile),
                "--merge-backtraces",
                "0",
                "--print-histogram",
                str(output / "allocation-sizes.tsv"),
                "--peak-limit",
                "10",
                "--sub-peak-limit",
                "3",
            ],
            stdout=summary,
            stderr=subprocess.STDOUT,
            check=True,
            timeout=30,
            preexec_fn=limit_file_output,
        )
    # The distro profiler may lack its optional Rust demangler. GNU binutils
    # handles Rust v0 symbols without rebuilding or changing the native host.
    with (
        (output / "summary.txt").open("rb") as source,
        (output / "summary-demangled.txt").open("wb") as destination,
    ):
        subprocess.run(
            [str(demangler), "--format=rust"],
            stdin=source,
            stdout=destination,
            check=True,
            timeout=10,
            preexec_fn=limit_file_output,
        )
    if profile_bytes(output) > MAX_PROFILE_BYTES:
        raise RuntimeError("Allocation artifacts exceeded 64 MiB")
    summary = (output / "summary.txt").read_text()
    calls = re.search(r"^calls to allocation functions: (\d+)", summary, re.MULTILINE)
    temporary = re.search(
        r"^temporary memory allocations: (\d+)", summary, re.MULTILINE
    )
    if calls is None or temporary is None or int(calls[1]) == 0:
        raise RuntimeError("Heaptrack did not report actual allocation calls")
    totals = {}
    for key in (
        "peak heap memory consumption",
        "peak RSS (including heaptrack overhead)",
        "total memory leaked",
    ):
        match = re.search(rf"^{re.escape(key)}: (.+)$", summary, re.MULTILINE)
        if match is None:
            raise RuntimeError(f"Missing heaptrack statistic: {key}")
        totals[key] = match[1]
    return {
        "profile": fingerprint(profile),
        "allocationCalls": int(calls[1]),
        "temporaryAllocationCalls": int(temporary[1]),
        "reportedTotals": totals,
        "allocationSizes": fingerprint(output / "allocation-sizes.tsv"),
        "summary": fingerprint(output / "summary.txt"),
        "demangledStacks": fingerprint(output / "summary-demangled.txt"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--host", type=Path, required=True)
    parser.add_argument("--host-profile", choices=("dev", "release"), required=True)
    parser.add_argument("--mode", choices=("development", "aot"), required=True)
    parser.add_argument("--heaptrack-prefix", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not args.host.is_absolute() or not args.host.is_file():
        parser.error(
            "Supply an absolute prebuilt native host and explicit fixture command"
        )
    if os.environ.get("LD_PRELOAD") or os.environ.get("DUMP_HEAPTRACK_OUTPUT"):
        parser.error(
            "The allocation run requires an environment without another profiler"
        )
    if not DRIVER.proc_identity_matches() or not os.environ.get("DISPLAY"):
        raise DRIVER.Unsupported(
            "A private X11 display and matching /proc are required"
        )
    frontend = shutil.which("heaptrack")
    demangler = shutil.which("c++filt")
    if demangler is None:
        parser.error("Install binutils for Rust v0 stack demangling")
    demangler = Path(demangler).resolve()
    prefix = args.heaptrack_prefix
    if prefix is None:
        if frontend is None:
            parser.error(
                "Install the heaptrack CLI package or supply --heaptrack-prefix"
            )
        prefix = Path(frontend).resolve().parents[1]
    library = (prefix / "lib/heaptrack/libheaptrack_preload.so").resolve()
    interpreter = (prefix / "lib/heaptrack/libexec/heaptrack_interpret").resolve()
    printer = (prefix / "bin/heaptrack_print").resolve()
    frontend = (prefix / "bin/heaptrack").resolve()
    for path in (library, interpreter, printer, frontend):
        if not path.is_file():
            parser.error(f"Missing heaptrack component: {path}")
    args.output.mkdir()
    output = args.output.resolve()
    host = args.host.resolve()
    sources = source_snapshot()
    wrapper = output / "profiled-host"
    identity = output / "host-identity.json"
    write_host_wrapper(wrapper, host, library, identity, MAX_PROFILE_BYTES)
    artifacts = {
        "host": fingerprint(host),
        "wrapper": fingerprint(wrapper),
        "heaptrackPreload": fingerprint(library),
        "heaptrackInterpret": fingerprint(interpreter),
        "heaptrackPrint": fingerprint(printer),
        "heaptrackFrontend": fingerprint(frontend),
        "rustDemangler": fingerprint(demangler),
    }
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "instrumented": True,
        "hostProfile": args.host_profile,
        "applicationMode": args.mode,
        "aotVerifiedByProfiler": False,
        "profilerVersion": DRIVER.run([str(frontend), "--version"]),
        "demanglerVersion": DRIVER.run([str(demangler), "--version"]).splitlines()[0],
        "artifacts": artifacts,
        "sourceFiles": sources,
        "command": command,
        "scope": "Full native host lifetime: startup, 1000 public lifecycle cycles, OS close and shutdown. Only the GPUI host is preloaded; Bun is not profiled. Standard heaptrack allocation-function interception excludes GPU memory, stacks and allocator paths bypassing malloc. Symbol-only host builds cannot provide full source-line/inline attribution. Instrumented timing/RSS are not baseline measurements; heaptrack's leaked label means allocations outstanding at exit, not proven application leaks.",
    }
    environment = {
        **os.environ,
        "BUN_NATIVE_HOST": str(wrapper),
        "BUN_NATIVE_HOST_PROFILE": args.host_profile,
    }
    driver_command = [
        sys.executable,
        str(ROOT / "scripts/quality/native-input-linux.py"),
        "--output",
        str(output / "lifecycle"),
        "--mode",
        args.mode,
        "--timeout",
        "60",
        "--title",
        "Bun Native public lifecycle",
        "--expect-software-renderer",
        "--expect-initial-render",
        json.dumps(DRIVER.lifecycle_fixture_paint(1, "Ready")),
        "--click",
        "100",
        "130",
        "--expect-event",
        json.dumps(DRIVER.lifecycle_fixture_event()),
        "--expect-render",
        json.dumps(DRIVER.lifecycle_fixture_paint(3002, "Completed 1000 cycles")),
        "--",
        *command,
    ]
    process = None
    observed = {}
    DRIVER.enable_subreaper()
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGALRM, interrupt)
    signal.alarm(120)
    try:
        with (output / "driver.log").open("wb") as log:
            process = subprocess.Popen(
                driver_command,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=environment,
                start_new_session=True,
            )
            deadline = time.monotonic() + 70
            while process.poll() is None:
                owned = sample_owned(process, observed)
                if "observedNativeProcess" not in report and identity.exists():
                    recorded = json.loads(identity.read_text())
                    proof = observe_native_process(recorded, owned, host, library)
                    if proof is not None:
                        report["observedNativeProcess"] = proof
                if time.monotonic() >= deadline:
                    raise RuntimeError("Instrumented lifecycle exceeded 70 seconds")
                if profile_bytes(output) > MAX_PROFILE_BYTES:
                    raise RuntimeError("Allocation artifacts exceeded 64 MiB")
                time.sleep(0.02)
            if process.wait() != 0:
                raise RuntimeError(
                    "Instrumented native lifecycle failed; inspect lifecycle/result.json"
                )
        if "observedNativeProcess" not in report:
            raise RuntimeError(
                "The owned real host and loaded profiling library were not observed"
            )
        report["lifecycle"] = fingerprint(output / "lifecycle/result.json")
        report["rawTrace"] = {**fingerprint(output / "native.raw"), "retained": False}
        report["allocations"] = analyze(output, interpreter, printer, demangler)
        if source_snapshot() != sources or any(
            fingerprint(Path(value["path"])) != value for value in artifacts.values()
        ):
            raise RuntimeError(
                "Source, native host or profiling tool changed during the run"
            )
        report["status"] = "passed"
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if process is not None:
            report["cleanup"] = cleanup_driver(process, observed)
            if (
                report["cleanup"]["forced_termination"]
                or report["cleanup"]["remaining_observed_pids"]
                or report["cleanup"]["unreaped_observed_pids"]
            ):
                report["status"] = "failed"
        if "rawTrace" in report:
            report["rawTrace"]["retained"] = (output / "native.raw").exists()
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "status": report["status"],
                "report": str(output / "result.json"),
                "error": report.get("error"),
            }
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
