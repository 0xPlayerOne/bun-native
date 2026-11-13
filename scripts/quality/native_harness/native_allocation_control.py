"""Bounded actual Rust/Heaptrack selection control; never launches a GPUI host."""

import argparse
import hashlib
import json
import logging
import os
import platform
import re
import resource
import shutil
import signal
import sys
from pathlib import Path

from . import allocation_phases as PHASES
from . import native_allocation_linux as PROFILE
from .common import ROOT

LOGGER = logging.getLogger(__name__)

PAIRS = PHASES.PAIRS
require = PAIRS.require
fingerprint = PHASES.fingerprint
LIMIT = 64 * 1024 * 1024
LIBRARY_SHA256 = "134760dbba8d9a2cd1b45f639c119f5c0cd779674a496fb7ed2b6baacac15ca9"


def artifact(path):
    return {"path": str(path), **fingerprint(path)}


def tools(library):
    require(platform.machine() == "x86_64", "The qualified profiler build is Linux x64")
    require(
        fingerprint(library)["sha256"] == LIBRARY_SHA256,
        "Installed profiler differs from the declared 1.5.0 bytes",
    )
    prefix = library.parents[2]
    values = {
        "library": library,
        "interpreter": prefix / "lib/heaptrack/libexec/heaptrack_interpret",
        "printer": prefix / "bin/heaptrack_print",
    }
    for name, command in [
        ("demangler", "c++filt"),
        ("environment", "env"),
        ("limits", "prlimit"),
    ]:
        executable = shutil.which(command)
        require(executable is not None, f"Missing declared control tool: {command}")
        values[name] = Path(executable).resolve()
    require(
        all(path.is_file() for path in values.values()), "Profiler tool is unavailable"
    )
    require(
        PAIRS.small_command([str(values["printer"]), "--version"], ROOT)
        == "heaptrack_print 1.5.0",
        "Unqualified profiler interface",
    )
    return {name: artifact(path) for name, path in values.items()}


def capped(command, identities, cap=LIMIT):
    limit = min(
        [cap]
        + [
            value
            for value in resource.getrlimit(resource.RLIMIT_FSIZE)
            if value != resource.RLIM_INFINITY
        ]
    )
    return [
        identities["environment"]["path"],
        "--default-signal=XFSZ",
        identities["limits"]["path"],
        f"--fsize={limit}:{limit}",
        "--core=0:0",
        "--",
        *command,
    ]


def clean(outcome):
    cleanup = outcome["cleanup"]
    return (
        not cleanup["remaining_observed_pids"]
        and not cleanup["unreaped_observed_pids"]
        and not outcome.get("pipe_cleanup_failed")
    )


def checked(command, output, timeout=30, environment=None):
    result = PAIRS.run_owned(command, ROOT, output, timeout, environment=environment)
    require(
        result["status"] == "passed" and clean(result),
        "Control command failed; retained its process evidence",
    )
    return result


def allocation_stack_counts(text):
    """Count exact control frames, including the pinned Rust v0 crate identity."""
    counts = {"selected_allocation": 0, "outside_region": 0}
    pattern = re.compile(
        r"selection_control(?:\[[0-9a-f]{1,16}\])?::"
        r"(selected_allocation|outside_region) \(selection-control\.rs\)"
    )
    for line in text.splitlines():
        stack, separator, count = line.rpartition(" ")
        require(
            separator and count.isascii() and count.isdecimal(),
            "Invalid folded allocation count",
        )
        functions = {
            match.group(1)
            for frame in stack.split(";")
            if (match := pattern.fullmatch(frame.strip())) is not None
        }
        for function in functions:
            counts[function] += int(count)
    return counts


def interpret_control(directory, identities, expected):
    # This tiny stdin adapter creates no supervisor of its own. Its descendants,
    # output cap and overall deadline are owned by the existing run_owned path.
    adapter = "import subprocess,sys\nwith open(sys.argv[1], 'rb') as source:\n subprocess.run(sys.argv[2:], stdin=source, check=True, timeout=20)\n"
    checked(
        capped(
            [
                sys.executable,
                "-c",
                adapter,
                str(directory / "allocation.raw"),
                identities["interpreter"]["path"],
            ],
            identities,
        ),
        directory / "interpret",
        25,
    )
    folded = directory / "stacks.txt"
    checked(
        capped(
            [
                identities["printer"]["path"],
                "--file",
                str(directory / "interpret/stdout.log"),
                "--print-peaks",
                "0",
                "--print-leaks",
                "0",
                "--print-temporary",
                "0",
                "--print-allocators",
                "1",
                "--merge-backtraces",
                "0",
                "--print-flamegraph",
                str(folded),
                "--flamegraph-cost-type",
                "allocations",
            ],
            identities,
        ),
        directory / "print",
        25,
    )
    checked(
        capped(
            [
                sys.executable,
                "-c",
                adapter,
                str(folded),
                identities["demangler"]["path"],
                "--format=rust",
            ],
            identities,
        ),
        directory / "demangle",
        25,
    )
    counts = allocation_stack_counts((directory / "demangle/stdout.log").read_text())
    require(
        counts == {"selected_allocation": expected, "outside_region": 0},
        "Actual inside/outside allocation stacks disagree with the control",
    )
    return {
        "allocationStackCounts": counts,
        "raw": fingerprint(directory / "allocation.raw"),
        "demangledStacks": fingerprint(directory / "demangle/stdout.log"),
    }


def wrong_library():
    # Only for the missing-ABI negative; no foreign process or arbitrary PID.
    for line in Path("/proc/self/maps").read_text().splitlines():
        fields = line.split(None, 5)
        if len(fields) == 6 and Path(fields[5]).name == "libc.so.6":
            return Path(fields[5]).resolve()
    raise ValueError("The declared missing-ABI negative needs the current libc mapping")


def run_case(name, phase, executable, directory, build_id, identities):
    directory.mkdir(mode=0o700)
    nonce = os.urandom(16).hex()
    source = PAIRS.VARIANTS["bn1"]["commit"]
    library = Path(identities["library"]["path"])
    proof = None
    row = {"status": "failed", "name": name, "phase": phase, "nonce": nonce}
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("BUN_NATIVE_ALLOCATION")
    }
    for key in ("LD_PRELOAD", "DUMP_HEAPTRACK_OUTPUT"):
        require(not environment.get(key), "Another profiler is already configured")
        environment.pop(key, None)
    if name != "disabled":
        environment.update(
            {
                "BUN_NATIVE_ALLOCATIONS": "1",
                "BUN_NATIVE_ALLOCATION_NONCE": nonce,
                "BUN_NATIVE_ALLOCATION_SOURCE": source,
                "BUN_NATIVE_ALLOCATION_BUILD_ID": build_id,
                "BUN_NATIVE_ALLOCATION_PHASE": phase,
                "BUN_NATIVE_ALLOCATION_OUTPUT": str(directory),
                "BUN_NATIVE_ALLOCATION_PRELOAD": str(library),
                "BUN_NATIVE_ALLOCATION_CONTROL_GRANT": str(
                    directory / "identity-grant"
                ),
            }
        )
    if name == "missing-abi":
        environment["BUN_NATIVE_ALLOCATION_PRELOAD"] = str(wrong_library())
        row["negativeLibrary"] = artifact(
            Path(environment["BUN_NATIVE_ALLOCATION_PRELOAD"])
        )
    if name == "collision":
        (directory / "allocation.raw").write_bytes(b"preserve-existing-output\n")

    def observe(app, _natives):
        nonlocal proof
        if name in ("disabled", "missing-abi", "collision") or proof is not None:
            return
        table = PAIRS.DRIVER.process_table()
        current = table.get(app.pid)
        if current is None:
            return
        candidate = PROFILE.observe_native_process(
            {"pid": app.pid, "start_ticks": current["start_ticks"]},
            {app.pid: current},
            executable,
            library,
        )
        latest = PAIRS.DRIVER.process_table().get(app.pid)
        if candidate and latest and latest["start_ticks"] == current["start_ticks"]:
            proof = candidate
            with (directory / "identity-grant").open("x") as grant:
                grant.write(nonce)

    flags = {
        "mismatch": ["--mismatch"],
        "deadline": ["--hold"],
        "file-cap": ["--flood"],
    }.get(name, [])
    try:
        result = PAIRS.run_owned(
            capped(
                [str(executable), *flags],
                identities,
                32768 if name == "file-cap" else LIMIT,
            ),
            ROOT,
            directory / "process",
            1 if name == "deadline" else 5,
            environment=environment,
            observe=observe,
        )
        row.update(process=result, mapping=proof)
        require(clean(result), "Control process ownership/pipe cleanup was incomplete")
        if name == "deadline":
            require(
                result["status"] == "failed"
                and result["error"]["type"] == "TimeoutError"
                and result["cleanup"]["forced_termination"],
                "Deadline control did not terminate the owned active region",
            )
        else:
            require(
                not result["cleanup"]["forced_termination"],
                "Control needed unexpected forced termination",
            )
        errors = (directory / "process/stderr.log").read_text()
        if name in ("disabled", "individual", "batch"):
            require(result["status"] == "passed", "Positive control failed")
        elif name in ("mismatch", "missing-abi", "collision"):
            require(
                result["status"] == "failed"
                and result.get("error", {}).get("message") == "Command exited 78",
                "Negative control did not return its precise diagnostic error",
            )
            expected = {
                "mismatch": "missing, repeated or reordered selected request",
                "missing-abi": "required profiler ABI symbol is missing",
                "collision": "diagnostic output must be new and writable",
            }[name]
            require(expected in errors, "Negative failed in another phase")
        elif name == "file-cap":
            require(
                result["status"] == "failed"
                and result.get("error", {}).get("message")
                == f"Command exited {-signal.SIGXFSZ}",
                "Trace cap did not terminate with SIGXFSZ",
            )
            require(
                (directory / "allocation.raw").stat().st_size == 32768,
                "Trace cap control did not reach the declared file bound",
            )
        if name == "disabled":
            require(
                {path.name for path in directory.iterdir()} == {"process"},
                "Disabled gate created diagnostic files",
            )
        if name in ("individual", "batch", "mismatch", "deadline", "file-cap"):
            require(
                proof is not None,
                "Exact owned executable and profiler mapping were not observed",
            )
        if name in ("individual", "batch"):
            completed = PAIRS.read_json(directory / "completed.json")
            PHASES.validate_region(
                completed, phase, nonce, source, build_id, proof["pid"]
            )
            count = 1000 if phase == "individual" else 10
            require(
                completed["rootRenderEntries"] == count,
                "Manual control render-entry count differs",
            )
            row.update(
                region=completed, stacks=interpret_control(directory, identities, count)
            )
        if name == "mismatch":
            completed = PAIRS.read_json(directory / "completed.json")
            require(
                completed["status"] == "failed" and completed["appliedCommands"] == 0,
                "Mismatched request was not rejected before capture",
            )
        if name in ("deadline", "file-cap"):
            require(
                (directory / "allocation.raw").is_file()
                and not (directory / "completed.json").exists(),
                "Incomplete region was misreported as complete",
            )
        if name == "deadline":
            require(
                (directory / "process/stdout.log").read_text()
                == "selection-control: active region\n",
                "Deadline occurred before the owned control entered its selected region",
            )
        if name == "collision":
            require(
                (directory / "allocation.raw").read_bytes()
                == b"preserve-existing-output\n",
                "Existing output was changed",
            )
        row["status"] = "passed"
        return row
    except (Exception, KeyboardInterrupt) as error:
        row["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        PAIRS.write_json(directory / "result.json", row)


def run(args, report):
    sources = PHASES.diagnostic_sources()
    identities = tools(args.library)
    compiler = Path(PAIRS.small_command(["rustup", "which", "rustc"], ROOT)).resolve()
    version = PAIRS.small_command([str(compiler), "--version", "--verbose"], ROOT)
    require(version.startswith("rustc 1.98.1 "), "Use exact pinned Rust 1.98.1")
    report.update(
        sources=sources,
        profiler=identities,
        compiler={**artifact(compiler), "version": version},
        cases=[],
    )
    build_id = hashlib.sha256(
        json.dumps(
            {"sources": sources, "compiler": report["compiler"]}, sort_keys=True
        ).encode()
    ).hexdigest()
    report["buildId"] = build_id
    environment = {**os.environ, "BUN_NATIVE_ALLOCATION_BUILD_ID": build_id}
    rlib = args.output / "libbun_native_allocation_diagnostic.rlib"
    report["libraryBuild"] = checked(
        [
            str(compiler),
            "--edition=2024",
            "--crate-type=rlib",
            "--crate-name=bun_native_allocation_diagnostic",
            "-Dwarnings",
            "-Copt-level=3",
            "-Cdebuginfo=1",
            "-Cembed-bitcode=yes",
            str(PHASES.CRATE / "src/lib.rs"),
            "-o",
            str(rlib),
        ],
        args.output / "library-build",
        environment=environment,
    )
    report["rlib"] = artifact(rlib)
    executable = args.output / "selection-control"
    report["controlBuild"] = checked(
        [
            str(compiler),
            "--edition=2024",
            "--crate-name=selection_control",
            "-Dwarnings",
            "-Copt-level=2",
            "-Cdebuginfo=1",
            "--extern",
            f"bun_native_allocation_diagnostic={rlib}",
            str(PHASES.CRATE / "examples/selection-control.rs"),
            "-o",
            str(executable),
        ],
        args.output / "control-build",
        environment=environment,
    )
    report["control"] = artifact(executable)
    plan = [
        ("disabled", "batch"),
        ("individual", "individual"),
        ("batch", "batch"),
        ("mismatch", "batch"),
        ("missing-abi", "batch"),
        ("collision", "batch"),
        ("deadline", "batch"),
        ("file-cap", "batch"),
    ]
    report["plan"] = [{"name": name, "phase": phase} for name, phase in plan]
    PAIRS.write_json(args.output / "plan.json", report)
    for name, phase in plan:
        report["cases"].append(
            run_case(name, phase, executable, args.output / name, build_id, identities)
        )
        PAIRS.write_json(args.output / "result.json", report)
    require(
        PHASES.diagnostic_sources() == sources,
        "Diagnostic sources changed during control",
    )
    require(
        tools(args.library) == identities
        and fingerprint(compiler)
        == {key: report["compiler"][key] for key in ("bytes", "sha256")},
        "Compiler or profiler tools changed",
    )
    require(
        artifact(rlib) == report["rlib"] and artifact(executable) == report["control"],
        "Qualified control artifacts changed",
    )
    report["status"] = "passed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--library",
        type=Path,
        default=Path("/usr/lib/heaptrack/libheaptrack_preload.so"),
    )
    args = parser.parse_args()
    if not args.output.is_absolute() or not args.library.is_absolute():
        parser.error("Paths must be absolute")
    args.output = args.output.resolve()
    args.library = args.library.resolve()
    args.output.mkdir(mode=0o700)
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "startedAt": PAIRS.timestamp(),
        "scope": "Standalone Rust ABI/allocation control; manual render counter calls. No GPUI, native workload timing or leak claim.",
    }
    try:
        require(
            platform.system() == "Linux" and PAIRS.DRIVER.proc_identity_matches(),
            "Use the actual Linux process namespace",
        )
        PAIRS.DRIVER.enable_subreaper()
        run(args, report)
    except (Exception, KeyboardInterrupt) as error:
        report["status"] = "failed"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        LOGGER.exception("Owned native allocation control failed")
    finally:
        report["finishedAt"] = PAIRS.timestamp()
        PAIRS.write_json(args.output / "result.json", report)
    print(
        json.dumps(
            {
                "status": report["status"],
                "output": str(args.output),
                "error": report.get("error"),
            }
        )
    )
    return 0 if report["status"] == "passed" else 1
