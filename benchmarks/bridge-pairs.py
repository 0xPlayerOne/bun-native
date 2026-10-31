#!/usr/bin/env python3
"""Build and compare the two exact historical revisions named in issue #297.

The unchanged clients own the workload. This controller supplies build/source
attestation, a predeclared paired order and the existing native driver's owned
process cleanup. It never disables events or retries a failed observation.
"""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import statistics
import subprocess
import threading
import time


REPOSITORY = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "native_baseline", REPOSITORY / "benchmarks/native-baseline.py"
)
BASELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASELINE)
DRIVER = BASELINE.NATIVE_INPUT
VARIANTS = {
    "bn1": {"commit": "6ea507b58d0249b752ff62691ebc1879f3fcf6da", "protocol": 2},
    "events": {"commit": "4549e75ca5463f136898a2f5fb49d22b58dffa11", "protocol": 4},
}
MODES = ("development", "aot")
MAX_JSON_BYTES = 4 * 1024 * 1024
TRIAL_TIMEOUT = 140
SEMANTICS = [
    "cross-window handles",
    "cycle/orphan rejection",
    "failed batch revision/ID rollback",
    "stale input revision",
    "subtree revocation",
    "closed-window ID reuse",
    "other-window continued use",
    "global UI sequence",
]


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    def finite_number(text):
        number = float(text)
        if not math.isfinite(number):
            raise ValueError("Non-finite JSON number")
        return number

    def invalid_constant(_text):
        raise ValueError("Non-finite JSON constant")

    with path.open("rb") as stream:
        data = stream.read(MAX_JSON_BYTES + 1)
    require(len(data) <= MAX_JSON_BYTES, "Metadata exceeds 4 MiB")
    return json.loads(data, parse_float=finite_number, parse_constant=invalid_constant)


def write_json(path, value):
    encoded = json.dumps(value, indent=2, allow_nan=False) + "\n"
    require(len(encoded.encode()) <= MAX_JSON_BYTES, "Metadata exceeds 4 MiB")
    pending = path.with_name(path.name + ".pending")
    pending.write_text(encoded)
    pending.replace(path)


def small_command(command, cwd):
    result = subprocess.run(command, cwd=cwd, capture_output=True, timeout=15)
    require(
        result.returncode == 0 and len(result.stdout) < 65_536,
        f"Identity command failed: {command[0]}",
    )
    return result.stdout.decode().strip()


def source_identity(repository, name):
    require(name in VARIANTS, "Unknown historical variant")
    expected = VARIANTS[name]["commit"]
    require(
        small_command(["git", "rev-parse", "HEAD"], repository) == expected,
        f"{name} must use the exact recorded merge {expected}",
    )
    require(
        small_command(["git", "status", "--porcelain"], repository) == "",
        f"{name} source checkout must be clean",
    )
    paths = BASELINE.expected_sources(repository) | {"benchmarks/bridge.ts"}
    paths.update(
        path.relative_to(repository).as_posix()
        for path in (repository / "experiments/aot-gpui").glob("*.ts")
        if not path.name.endswith(".test.ts")
    )
    return {
        "commit": expected,
        "files": [
            {"path": path, **BASELINE.fingerprint(repository / path)}
            for path in sorted(paths)
        ],
    }


def own_snapshot(app, observed, expected_host, native):
    table = DRIVER.process_table()
    rows = DRIVER.owned_processes(app.pid, table)
    for row in rows:
        observed[row["pid"]] = row["start_ticks"]
        if expected_host is not None and row["pid"] != app.pid:
            try:
                executable = Path(f"/proc/{row['pid']}/exe").resolve(strict=True)
                current = DRIVER.process_table().get(row["pid"])
            except (OSError, RuntimeError):
                continue
            if (
                executable == expected_host
                and current is not None
                and current["start_ticks"] == row["start_ticks"]
            ):
                native[str(row["pid"])] = {
                    "start_ticks": row["start_ticks"],
                    "executable": str(executable),
                }


def run_owned(command, cwd, output, timeout, *, expected_host=None, environment=None):
    """Bounded command capture; all PID authority/termination uses the shared driver."""
    output.mkdir()
    report = {
        "command": command,
        "cwd": str(cwd),
        "started_at": timestamp(),
        "timeout_seconds": timeout,
        "status": "failed",
        "logs": {},
        "observed_native_processes": {},
        "load_average_before": os.getloadavg(),
    }
    app = None
    observed = {}
    threads = []
    started = time.monotonic()
    previous = signal.getsignal(signal.SIGTERM)
    cancellation = None

    def interrupted(signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise InterruptedError(f"Paired measurement received signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        app = subprocess.Popen(
            command,
            cwd=cwd,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        for name, stream in [("stdout", app.stdout), ("stderr", app.stderr)]:
            stats = {"written_bytes": 0, "discarded_bytes": 0}
            report["logs"][name] = stats
            thread = threading.Thread(
                target=DRIVER.capture,
                args=(stream, output / f"{name}.log", stats),
                daemon=True,
            )
            thread.start()
            threads.append((thread, stream))
        while True:
            own_snapshot(
                app, observed, expected_host, report["observed_native_processes"]
            )
            if app.poll() is not None:
                break
            if time.monotonic() - started > timeout:
                raise TimeoutError("Command exceeded its fixed outer deadline")
            if any(stats["discarded_bytes"] for stats in report["logs"].values()):
                raise RuntimeError("Command log exceeded the 4 MiB stream bound")
            time.sleep(0.1)
        require(app.returncode == 0, f"Command exited {app.returncode}")
        if expected_host is not None:
            require(
                len(report["observed_native_processes"]) == 1,
                "Exactly one identity-verified native child must be observed",
            )
        report["status"] = "passed"
    except BaseException as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        if isinstance(error, (InterruptedError, KeyboardInterrupt)):
            cancellation = error
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            if app is not None:
                # Also covers cancellation immediately after Popen, before sampling.
                own_snapshot(
                    app, observed, expected_host, report["observed_native_processes"]
                )
                report["cleanup"] = DRIVER.cleanup(app, observed)
                if (
                    report["cleanup"]["forced_termination"]
                    or report["cleanup"]["remaining_observed_pids"]
                    or report["cleanup"]["unreaped_observed_pids"]
                ):
                    report["status"] = "failed"
            for thread, stream in threads:
                thread.join(timeout=1)
                if thread.is_alive():
                    report["status"] = "failed"
                    report["pipe_cleanup_failed"] = True
                else:
                    stream.close()
            if any(stats["discarded_bytes"] for stats in report["logs"].values()):
                report["status"] = "failed"
            report["elapsed_seconds"] = time.monotonic() - started
            report["finished_at"] = timestamp()
            report["load_average_after"] = os.getloadavg()
            write_json(output / "supervisor.json", report)
        finally:
            signal.signal(signal.SIGTERM, previous)
    if cancellation is not None:
        raise cancellation
    return report


def plan_trials(pairs, warmups):
    require(type(pairs) is int and 5 <= pairs <= 10, "Choose 5–10 measured pairs")
    require(type(warmups) is int and 1 <= warmups <= 2, "Choose 1–2 equal full warmups")
    plan = []
    for stage, count in [("warmup", warmups), ("measured", pairs)]:
        for pair in range(count):
            modes = MODES if pair % 2 == 0 else tuple(reversed(MODES))
            order = list(VARIANTS) if pair % 2 == 0 else list(reversed(VARIANTS))
            for mode in modes:
                for variant in order:
                    plan.append(
                        {
                            "id": f"{stage}-{pair + 1:02d}-{mode}-{variant}",
                            "stage": stage,
                            "pair": pair + 1,
                            "mode": mode,
                            "variant": variant,
                        }
                    )
    return plan


def prepare(args, report):
    require(args.target.is_absolute(), "Cargo target must be absolute")
    require(
        not args.target.is_relative_to(args.output),
        "Cargo target is not an evidence artifact",
    )
    report["bun"] = {"path": str(args.bun), **BASELINE.fingerprint(args.bun)}
    report["variants"] = {}
    report["controller"] = controller_identity()
    report["machine"] = BASELINE.machine_metadata()
    report["tools"] = {
        "bun_revision": small_command([str(args.bun), "--revision"], REPOSITORY),
        "rustc": small_command(["rustc", "--version", "--verbose"], REPOSITORY),
        "cargo": small_command(["cargo", "--version"], REPOSITORY),
    }
    pins = None
    for name in VARIANTS:
        repository = (args.sources / name).resolve(strict=True)
        source = source_identity(repository, name)
        current_pins = read_json(repository / "toolchain.json")
        pins = current_pins if pins is None else pins
        require(current_pins == pins, "Historical Bun/Rust/GPUI pins must match")
        require(
            report["tools"]["bun_revision"] == pins["bun"]["cliRevision"],
            "The installed Bun revision must match both exact historical pins",
        )
        require(
            report["tools"]["rustc"].splitlines()[0].startswith("rustc 1.98.1 "),
            "Use the exact pinned Rust 1.98.1 toolchain",
        )
        directory = args.output / name
        directory.mkdir()
        host = directory / "bun-native-host"
        package = directory / "package"
        variant = {
            "repository": str(repository),
            "source": source,
            "toolchain": pins,
            "host_path": str(host),
            "package": str(package),
            "steps": [],
        }
        report["variants"][name] = variant
        environment = {
            **os.environ,
            "CARGO_TARGET_DIR": str(args.target),
            "CARGO_INCREMENTAL": "0",
            "CARGO_BUILD_JOBS": "2",
        }
        commands = [
            (
                "dependencies",
                [str(args.bun), "install", "--frozen-lockfile", "--ignore-scripts"],
                120,
            ),
            (
                "release-host",
                ["cargo", "build", "--locked", "--release", "-p", "bun-native-host"],
                1800,
            ),
            (
                "aot",
                [
                    str(args.bun),
                    "experiments/aot-gpui/build-window.ts",
                    "--source",
                    str(repository),
                    "--host",
                    str(host),
                    "--host-profile",
                    "release",
                    "--entry",
                    "bridge",
                    "--outdir",
                    str(package),
                ],
                150,
            ),
        ]
        for step, command, timeout in commands:
            if step == "aot":
                shutil.copyfile(args.target / "release/bun-native-host", host)
                host.chmod(0o500)
            outcome = run_owned(
                command, repository, directory / step, timeout, environment=environment
            )
            variant["steps"].append({"name": step, "result": outcome})
            write_json(args.output / "build.json", report)
            require(
                outcome["status"] == "passed", f"{name} {step} failed; retained its log"
            )
        manifest = BASELINE.verify_package(
            package, repository, entry="bridge", external_host=host
        )
        require(manifest["source"]["dirty"] is False, "AOT source must be clean")
        require(
            manifest["source"]["commit"] == source["commit"],
            "AOT source commit differs",
        )
        require(
            source_identity(repository, name) == source, "Source changed during build"
        )
        variant["manifest"] = BASELINE.fingerprint(package / "manifest.json")
        variant["host"] = BASELINE.fingerprint(host)
        variant["application"] = BASELINE.fingerprint(package / "bridge")
    report["finished_at"] = timestamp()
    report["status"] = "passed"


def controller_identity():
    return [
        {"path": path, **BASELINE.fingerprint(REPOSITORY / path)}
        for path in [
            "benchmarks/bridge-pairs.py",
            "benchmarks/native-baseline.py",
            "scripts/quality/native-input-linux.py",
            "scripts/quality/native-linux-session.sh",
        ]
    ]


def verify_build(build, bun):
    require(build["status"] == "passed", "Both builds must finish before sampling")
    require(
        build["controller"] == controller_identity(),
        "Controller changed since preparation",
    )
    require(
        set(build["variants"]) == set(VARIANTS),
        "Exactly the two declared revisions are required",
    )
    require(
        BASELINE.fingerprint(bun)
        == {key: build["bun"][key] for key in ("bytes", "sha256")},
        "Bun executable changed since preparation",
    )
    manifests = {}
    for name, variant in build["variants"].items():
        repository = Path(variant["repository"])
        host = Path(variant["host_path"])
        package = Path(variant["package"])
        require(
            source_identity(repository, name) == variant["source"],
            "Exact historical source changed",
        )
        require(
            BASELINE.fingerprint(host) == variant["host"],
            "Native release artifact changed",
        )
        require(
            BASELINE.fingerprint(package / "bridge") == variant["application"],
            "AOT artifact changed",
        )
        require(
            BASELINE.fingerprint(package / "manifest.json") == variant["manifest"],
            "AOT manifest changed",
        )
        manifests[name] = BASELINE.verify_package(
            package, repository, entry="bridge", external_host=host
        )
        require(
            manifests[name]["source"]["commit"] == VARIANTS[name]["commit"],
            "AOT commit mismatch",
        )
        require(manifests[name]["source"]["dirty"] is False, "AOT source was modified")
        steps = variant["steps"]
        require(
            [step["name"] for step in steps] == ["dependencies", "release-host", "aot"],
            "Missing build steps",
        )
        require(
            all(step["result"]["status"] == "passed" for step in steps),
            "Incomplete build",
        )
    return manifests


def sample_distribution(record, count):
    values = record["samplesMs"]
    require(len(values) == count, "Incomplete acknowledgement sample array")
    require(
        all(
            type(value) in (int, float) and math.isfinite(value) and value >= 0
            for value in values
        ),
        "Acknowledgement samples must be finite nonnegative numbers",
    )
    ordered = sorted(values)
    expected = {"count": count, "totalMs": sum(values)}
    for name, fraction in [("p50Ms", 0.5), ("p95Ms", 0.95), ("p99Ms", 0.99)]:
        expected[name] = ordered[math.ceil(count * fraction) - 1]
    require(
        all(
            type(record[key]) in (int, float)
            and math.isclose(record[key], value, rel_tol=1e-12, abs_tol=1e-9)
            for key, value in expected.items()
        ),
        "Reported percentiles/sums do not match retained raw samples",
    )
    return {**expected, "over10Ms": sum(value > 10 for value in values)}


def verify_result(result, trial, build, manifest):
    name, mode = trial["variant"], trial["mode"]
    variant = build["variants"][name]
    require(
        result["status"] == "passed" and result["nativeExitCode"] == 0,
        "Native workload failed",
    )
    require(result["protocol"] == VARIANTS[name]["protocol"], "Wrong protocol client")
    if name == "events":
        require(
            type(result.get("nativeEventCount")) is int
            and result["nativeEventCount"] >= 3,
            "The event revision must retain its continuous global event drain",
        )
    require(result["semanticChecks"] == SEMANTICS, "Missing native semantic checks")
    require(
        result["source"]["commit"] == VARIANTS[name]["commit"]
        and result["source"]["dirty"] is False,
        "Wrong workload source",
    )
    require(
        result["source"]["files"] == manifest["source"]["files"],
        "Workload source hashes differ from AOT",
    )
    require(result["toolchain"] == manifest["toolchain"], "Workload toolchain changed")
    require(
        result["target"] == manifest["target"], "Workload target differs from its build"
    )
    execution = result["execution"]
    require(
        execution["mode"] == mode and execution["readonlyBuiltin"] is (mode == "aot"),
        "Execution mode witness mismatch",
    )
    require(
        execution["bunRevision"] == manifest["toolchain"]["bun"]["revision"],
        "Wrong runtime revision",
    )
    require(
        execution["application"]
        == (
            variant["application"]
            if mode == "aot"
            else {key: build["bun"][key] for key in ("bytes", "sha256")}
        ),
        "Workload executable hash mismatch",
    )
    if mode == "aot":
        require(
            execution["aotEvidence"]["manifest"] == variant["manifest"],
            "AOT evidence mismatch",
        )
    require(
        result["nativeHost"]["profile"] == "release", "Native profile must be release"
    )
    require(
        {key: result["nativeHost"][key] for key in ("bytes", "sha256")}
        == variant["host"],
        "Workload host hash mismatch",
    )
    methodology = result["methodology"]
    require(
        methodology["instrumentation"] is False,
        "Instrumented samples cannot enter the normal baseline",
    )
    require(
        [
            methodology[key]
            for key in ("warmupRequests", "textNodes", "nativeInputEntityLifecycles")
        ]
        == [20, 1000, 1000],
        "Historical workload dimensions changed",
    )
    return {
        "individual": sample_distribution(result["individual"], 1000),
        "batchesOf100": sample_distribution(result["batchesOf100"], 10),
    }


def paired_summary(trials):
    summaries = {}
    for mode in MODES:
        pairs = {}
        for trial in trials:
            if trial["stage"] == "measured" and trial["mode"] == mode:
                pairs.setdefault(trial["pair"], {})[trial["variant"]] = trial
        complete = [
            pair
            for pair in pairs.values()
            if len(pair) == 2
            and all(row["status"] == "passed" for row in pair.values())
        ]
        comparisons = {}
        for group, metrics in [
            ("individual", ("p50Ms", "p95Ms", "p99Ms", "totalMs", "over10Ms")),
            ("batchesOf100", ("p50Ms", "p95Ms", "p99Ms", "totalMs")),
        ]:
            for metric in metrics:
                rows = []
                for pair in complete:
                    before = pair["bn1"]["metrics"][group][metric]
                    after = pair["events"]["metrics"][group][metric]
                    rows.append(
                        {
                            "pair": pair["bn1"]["pair"],
                            "bn1": before,
                            "events": after,
                            "difference": after - before,
                            "ratio": after / before if before > 0 else None,
                        }
                    )
                differences = [row["difference"] for row in rows]
                ratios = [row["ratio"] for row in rows if row["ratio"] is not None]
                comparisons[f"{group}.{metric}"] = {
                    "pairs": rows,
                    "median_paired_difference": statistics.median(differences)
                    if differences
                    else None,
                    "median_paired_ratio": statistics.median(ratios)
                    if ratios
                    else None,
                }
        summaries[mode] = {"complete_pairs": len(complete), "comparisons": comparisons}
    return summaries


def collect(args, report):
    require(os.environ.get("DISPLAY"), "Run inside the shared isolated X11 session")
    require(
        os.environ.get("GPUI_X11_SCALE_FACTOR") == "1",
        "Require the shared scale-1 session",
    )
    require(
        os.environ.get("LIBGL_ALWAYS_SOFTWARE") == "1",
        "Require matched software-renderer request",
    )
    icd = Path(os.environ.get("VK_DRIVER_FILES", ""))
    require(icd.is_absolute() and icd.is_file(), "Require the explicit lavapipe ICD")
    require(
        not any(
            os.environ.get(key)
            for key in (
                "LD_PRELOAD",
                "BUN_NATIVE_EVIDENCE_LOG",
                "BUN_NATIVE_STARTUP_TRACE",
            )
        ),
        "Remove diagnostic instrumentation before normal collection",
    )
    build = read_json(args.prepared / "build.json")
    manifests = verify_build(build, args.bun)
    report.update(
        {
            "build": {
                "path": str(args.prepared / "build.json"),
                **BASELINE.fingerprint(args.prepared / "build.json"),
            },
            "machine": BASELINE.machine_metadata(),
            "controller": controller_identity(),
            "plan": plan_trials(args.pairs, args.warmups),
            "display": {
                key: os.environ.get(key)
                for key in (
                    "DISPLAY",
                    "WAYLAND_DISPLAY",
                    "GPUI_X11_SCALE_FACTOR",
                    "LIBGL_ALWAYS_SOFTWARE",
                    "VK_DRIVER_FILES",
                )
            },
            "vulkan_icd": {"path": str(icd), **BASELINE.fingerprint(icd)},
            "scope": "Complete historical revision comparison. Send-to-applied acknowledgements, not presentation or input latency. Normal native events remain enabled. No phase/stack attribution or performance-win claim.",
            "methodology": {
                "host_profile": "release",
                "workload": "Each unchanged revision's bridge.ts: 20 request warmups, 1000 individual updates, ten batches of 100 and 1000 input-entity lifecycles",
                "order": "AB/BA alternates by pair within each mode; mode block order also alternates. A=BN1, B=events. An odd pair count has one extra AB pair.",
                "fresh_process_per_trial": True,
                "compilation_before_all_trials": True,
                "process_sampling_interval_ms": 100,
                "os_caches": "uncontrolled; never flushed",
                "actual_gpui_adapter": "not recorded by uninstrumented workload; explicit Mesa ICD request and package versions retained",
                "power_and_runner_load": "uncontrolled; environment and before/after load averages retained",
                "failure_policy": "No retries; continue the declared sequence after a clean failed trial, stop if process cleanup is incomplete. Any failed warmup or measurement makes the collection fail.",
                "statistics": "Raw samples and paired descriptive ratios/differences. No causal attribution, significance test, percentile pooling or guessed performance budget.",
            },
        }
    )
    # The complete sequence is durable before the first workload starts.
    write_json(
        args.output / "plan.json",
        {key: report[key] for key in ("plan", "build", "methodology", "controller")},
    )
    report["trials"] = []
    for trial in report["plan"]:
        name, mode = trial["variant"], trial["mode"]
        variant = build["variants"][name]
        directory = args.output / trial["id"]
        directory.mkdir()
        package = Path(variant["package"])
        repository = Path(variant["repository"])
        command = (
            [str(args.bun), str(repository / "benchmarks/bridge.ts")]
            if mode == "development"
            else [str(package / "bridge")]
        )
        command += [
            "--mode",
            mode,
            "--host",
            variant["host_path"],
            "--host-profile",
            "release",
            "--source",
            str(repository),
            "--output",
            str(directory / "workload"),
        ]
        if mode == "aot":
            command += ["--aot-manifest", str(package / "manifest.json")]
        row = {**trial, "status": "failed"}
        report["trials"].append(row)
        try:
            outcome = run_owned(
                command,
                repository,
                directory / "process",
                TRIAL_TIMEOUT,
                expected_host=Path(variant["host_path"]),
            )
            row["supervisor"] = outcome
            require(
                outcome["status"] == "passed",
                "Native process/cleanup failed; see retained logs",
            )
            path = directory / "workload/result.json"
            result = read_json(path)
            require(
                result["display"]
                == {
                    "x11": report["display"]["DISPLAY"],
                    "wayland": report["display"]["WAYLAND_DISPLAY"],
                    "vulkanDriverFiles": report["display"]["VK_DRIVER_FILES"],
                    "softwareGlRequested": report["display"]["LIBGL_ALWAYS_SOFTWARE"],
                },
                "Workload display environment differs from the paired session",
            )
            row["metrics"] = verify_result(result, trial, build, manifests[name])
            row["raw_result"] = {
                "path": str(path.relative_to(args.output)),
                **BASELINE.fingerprint(path),
            }
            row["status"] = "passed"
        except Exception as error:
            row["error"] = {"type": type(error).__name__, "message": str(error)}
            if isinstance(error, InterruptedError):
                raise
        finally:
            write_json(args.output / "summary.json", report)
        cleanup = row.get("supervisor", {}).get("cleanup", {})
        require(
            not cleanup.get("remaining_observed_pids")
            and not cleanup.get("unreaped_observed_pids")
            and not row.get("supervisor", {}).get("pipe_cleanup_failed"),
            "Unsafe cleanup prevents further trials",
        )
    # Exact source, manifest and all executable identities must survive collection.
    verify_build(build, args.bun)
    report["paired"] = paired_summary(report["trials"])
    require(
        all(row["status"] == "passed" for row in report["trials"]),
        "Collection includes failed observations; no accepted comparison",
    )
    report["status"] = "passed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "run"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument("--sources", type=Path)
    parser.add_argument("--target", type=Path)
    parser.add_argument("--prepared", type=Path)
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--warmups", type=int, default=1)
    args = parser.parse_args()
    for name in ("output", "bun", "sources", "target", "prepared"):
        path = getattr(args, name)
        if path is not None:
            if not path.is_absolute():
                parser.error(f"--{name} requires an absolute path")
            setattr(args, name, path.resolve())
    if args.operation == "prepare" and (args.sources is None or args.target is None):
        parser.error("Preparation requires --sources and --target")
    if args.operation == "run" and args.prepared is None:
        parser.error("Sampling requires --prepared")
    args.output.mkdir()
    report = {
        "schema_version": 1,
        "status": "failed",
        "started_at": timestamp(),
        "operation": args.operation,
    }
    try:
        require(
            platform.system() == "Linux" and DRIVER.proc_identity_matches(),
            "Linux and /proc must share the process namespace",
        )
        DRIVER.enable_subreaper()
        if args.operation == "prepare":
            prepare(args, report)
        else:
            collect(args, report)
    except (Exception, KeyboardInterrupt) as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        report["finished_at"] = timestamp()
        if "trials" in report:
            report["paired"] = paired_summary(report["trials"])
        path = args.output / (
            "build.json" if args.operation == "prepare" else "summary.json"
        )
        write_json(path, report)
    print(
        json.dumps(
            {
                "status": report["status"],
                "output": str(path),
                "error": report.get("error"),
            }
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
