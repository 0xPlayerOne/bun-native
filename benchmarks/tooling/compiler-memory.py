#!/usr/bin/env python3
"""Run the four predeclared compiler-only controls once; never execute their output."""

import argparse
import hashlib
import json
import math
import os
import platform
import secrets
import shutil
import statistics
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
CASES = (("solid", 101), ("react", 101), ("solid", 1001), ("react", 1001))
CASE_TIMEOUT = 180
TOTAL_TIMEOUT = 900
MEMORY_FIELDS = ("rss", "heapTotal", "heapUsed", "external", "arrayBuffers")
MAX_LOG_BYTES = 8 * 1024 * 1024


def require(value, message):
    if not value:
        raise ValueError(message)


def artifact(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(64 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return {"bytes": size, "sha256": digest.hexdigest()}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPOSITORY, timeout=15).decode()


def source_identity():
    require(
        not git("status", "--porcelain"),
        "Experiment requires a clean committed checkout",
    )
    names = sorted(name for name in git("ls-files", "-z").split("\0") if name)
    return {
        "commit": git("rev-parse", "HEAD").strip(),
        "tree": git("rev-parse", "HEAD^{tree}").strip(),
        "files": [{"path": name, **artifact(REPOSITORY / name)} for name in names],
    }


def series(values):
    mean_x = (len(values) - 1) / 2
    mean_y = statistics.mean(values)
    xx = sum((index - mean_x) ** 2 for index in range(len(values)))
    yy = sum((value - mean_y) ** 2 for value in values)
    xy = sum((index - mean_x) * (value - mean_y) for index, value in enumerate(values))
    return {
        "count": len(values),
        "first": values[0],
        "last": values[-1],
        "minimum": min(values),
        "maximum": max(values),
        "median": statistics.median(values),
        "delta": values[-1] - values[0],
        "ols_bytes_per_build": xy / xx if xx else None,
        "r_squared": xy * xy / (xx * yy) if xx and yy else None,
    }


def read_rows(path):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "Duplicate worker record key")
            value[key] = item
        return value

    with path.open("rb") as stream:
        raw = stream.read(MAX_LOG_BYTES + 1)
    require(len(raw) <= MAX_LOG_BYTES, "Worker output exceeded its fixed 8 MiB limit")
    require(raw.endswith(b"\n"), "Worker output is incomplete")
    return [json.loads(line, object_pairs_hook=unique) for line in raw.splitlines()]


def inspect_rows(rows, framework, count, nonce, pid, revision, executable):
    require(len(rows) == count + 3, "Wrong number of streamed records")
    require(
        rows[0]["stage"] == "start" and rows[1]["stage"] == "initialized",
        "Missing startup records",
    )
    require(rows[0]["revision"] == revision, "Compiler revision mismatch")
    require(
        Path(rows[0]["executable"]).resolve() == executable,
        "Compiler executable mismatch",
    )
    elapsed = -1
    for row in rows:
        require(
            type(row["count"]) is int and type(row["pid"]) is int,
            "Invalid worker identity type",
        )
        require(
            (row["framework"], row["count"], row["nonce"], row["pid"])
            == (framework, count, nonce, pid),
            "Worker identity changed",
        )
        require(
            type(row["elapsedMs"]) in (int, float)
            and math.isfinite(row["elapsedMs"])
            and row["elapsedMs"] >= elapsed,
            "Invalid monotonic observation time",
        )
        elapsed = row["elapsedMs"]
        for field in MEMORY_FIELDS:
            value = row["memory"][field]
            require(
                type(value) is int and 0 <= value <= 2**53 - 1, "Invalid memory counter"
            )
    builds = rows[2:-1]
    for index, row in enumerate(builds):
        token = f"__bn_compiler_memory_{framework}_{count}_{nonce}_{index:04d}__"
        require(
            all(
                type(row[field]) is int
                for field in (
                    "index",
                    "attempted",
                    "successful",
                    "liveGenerationDirectories",
                )
            ),
            "Invalid build counter type",
        )
        require(
            type(row["module"]["occurrences"]) is int, "Invalid source-token count type"
        )
        require(
            row["stage"] == "build"
            and row["index"] == index
            and row["attempted"] == row["successful"] == index + 1
            and row["token"] == token
            and row["module"]["occurrences"] == 2
            and row["liveGenerationDirectories"] == 1,
            "Output version/count or generation ownership mismatch",
        )
        for field in ("bundleMs", "validationAndCleanupMs"):
            value = row[field]
            require(
                type(value) in (int, float) and math.isfinite(value) and value >= 0,
                "Invalid interval",
            )
        for field in ("source", "module", "sourcemap"):
            value = row[field]
            require(
                type(value["bytes"]) is int and value["bytes"] > 0,
                "Invalid artifact size",
            )
            require(
                isinstance(value["sha256"], str)
                and len(value["sha256"]) == 64
                and all(char in "0123456789abcdef" for char in value["sha256"]),
                "Invalid artifact hash",
            )
    require(
        len({row["source"]["sha256"] for row in builds}) == count,
        "Repeated source version",
    )
    require(
        len({row["module"]["sha256"] for row in builds}) == count,
        "Repeated compiled module",
    )
    final = rows[-1]
    require(
        final["stage"] == "final"
        and final["status"] == "passed"
        and final["attempted"] == final["successful"] == count
        and final["projectRemoved"] is True
        and final["bundlesRemoved"] is True
        and final["cleanupErrors"] == [],
        "Worker did not finish every build and remove its owned directories",
    )
    summary = {}
    for field in MEMORY_FIELDS:
        values = [row["memory"][field] for row in builds]
        summary[field] = {
            "all_builds": series(values),
            "quarters": [
                series(values[index * count // 4 : (index + 1) * count // 4])
                for index in range(4)
            ],
            "last_50_builds": series(values[-50:]),
        }
        if count == 1001:
            summary[field]["last_500_builds"] = series(values[-500:])
    return {"validated_builds": count, "memory": summary, "final": final}


def terminate_owned(child):
    child.terminate()
    try:
        return child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        return child.wait(timeout=2)


def run_case(
    framework,
    count,
    nonce,
    temporary_root,
    output,
    compiler,
    revision,
    deadline,
    children,
):
    name = f"{framework}-{count}"
    directory = output / name
    directory.mkdir()
    command = [
        str(compiler),
        str(REPOSITORY / "benchmarks/tooling/compiler-memory-worker.ts"),
        framework,
        str(count),
        nonce,
        str(temporary_root),
    ]
    report = {
        "framework": framework,
        "total_bundle_calls": count,
        "command": command,
        "status": "failed",
        "forced_termination": False,
        "started_at_utc": datetime.now(UTC).isoformat(),
    }
    start = time.monotonic()
    child = None
    try:
        remaining = min(CASE_TIMEOUT, deadline - start - 7)
        require(remaining > 0, "Fixed whole-experiment deadline exhausted")
        with (
            (directory / "rows.jsonl").open("xb") as stdout,
            (directory / "stderr.log").open("xb") as stderr,
        ):
            child = subprocess.Popen(
                command, cwd=REPOSITORY, stdout=stdout, stderr=stderr
            )
            children.append(child)
            report["pid"] = child.pid
            try:
                code = child.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                report["forced_termination"] = True
                code = terminate_owned(child)
            report["exit_code"] = code
        require(
            code == 0 and not report["forced_termination"],
            "Worker failed or exceeded the fixed bound",
        )
        report["observations"] = inspect_rows(
            read_rows(directory / "rows.jsonl"),
            framework,
            count,
            nonce,
            child.pid,
            revision,
            compiler,
        )
        require(
            not (temporary_root / name).exists(), "Worker left its bundle directory"
        )
        require(
            not (
                REPOSITORY / ".bun-native" / f"compiler-memory-{nonce}" / name
            ).exists(),
            "Worker left its source project",
        )
        report["status"] = "passed"
    except (
        OSError,
        ValueError,
        TypeError,
        KeyError,
        subprocess.SubprocessError,
        KeyboardInterrupt,
    ) as error:
        report["error"] = f"{type(error).__name__}: {error}"
        report["interrupted"] = isinstance(error, KeyboardInterrupt)
    finally:
        if child is not None and child.poll() is None:
            report["forced_termination"] = True
            try:
                report["exit_code"] = terminate_owned(child)
            except (OSError, subprocess.SubprocessError) as error:
                report["join_error"] = str(error)
        report["elapsed_seconds"] = time.monotonic() - start
        report["finished_at_utc"] = datetime.now(UTC).isoformat()
        report["direct_child_joined"] = child is None or child.poll() is not None
        for filename in ("rows.jsonl", "stderr.log"):
            path = directory / filename
            if path.exists():
                report[filename] = artifact(path)
        write_json(directory / "result.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    require(
        not output.is_relative_to(REPOSITORY),
        "Store experiment output outside the checkout",
    )
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    report = {
        "schema_version": 1,
        "status": "failed",
        "scope": "Compiler-only observations; no application, native host, watcher, malformed source or explicit GC",
        "predeclared_cases": list(CASES),
        "case_timeout_seconds": CASE_TIMEOUT,
        "whole_timeout_seconds": TOTAL_TIMEOUT,
        "cases": [],
        "started_at_utc": datetime.now(UTC).isoformat(),
    }
    temporary_root = None
    project_root = None
    children = []
    try:
        flags = sorted(
            key
            for key in os.environ
            if (
                key.startswith(("BUN_JSC_", "JSC_"))
                or key in ("BUN_OPTIONS", "NODE_OPTIONS")
            )
            and os.environ[key]
        )
        report["inherited_runtime_option_keys"] = flags
        require(
            not flags, "Runtime option overrides are outside this predeclared control"
        )
        compiler = Path(shutil.which(args.bun) or args.bun).resolve(strict=True)
        source = source_identity()
        report["source"] = source
        pin = json.loads((REPOSITORY / "toolchain.json").read_text())["bun"]
        report["compiler"] = {
            "path": str(compiler),
            "expected_revision": pin["revision"],
            **artifact(compiler),
        }
        report["platform"] = {
            "system": platform.system(),
            "release": platform.release(),
            "version": platform.version(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "logical_cpus": os.cpu_count(),
        }
        nonce = secrets.token_hex(16)
        report["nonce"] = nonce
        temporary_root = Path(
            tempfile.mkdtemp(prefix=f"bun-native-compiler-memory-{nonce}-")
        ).resolve()
        project_candidate = REPOSITORY / ".bun-native" / f"compiler-memory-{nonce}"
        project_candidate.mkdir(parents=True, exist_ok=False)
        project_root = project_candidate
        write_json(output / "started.json", report)
        for framework, count in CASES:
            result = run_case(
                framework,
                count,
                nonce,
                temporary_root,
                output,
                compiler,
                pin["revision"],
                started + TOTAL_TIMEOUT,
                children,
            )
            report["cases"].append(result)
            require(
                result["direct_child_joined"],
                "Direct child remains alive; do not start another case",
            )
            require(
                not result.get("interrupted"),
                "Experiment interrupted; do not start another case",
            )
        require(
            source_identity() == source, "Tracked source changed during the control"
        )
        require(
            artifact(compiler)
            == {key: report["compiler"][key] for key in ("bytes", "sha256")},
            "Compiler changed during the control",
        )
        require(
            all(row["status"] == "passed" for row in report["cases"]),
            "At least one declared case failed",
        )
        report["status"] = "passed"
    except (
        OSError,
        ValueError,
        TypeError,
        KeyError,
        subprocess.SubprocessError,
        KeyboardInterrupt,
    ) as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        joined = all(child.poll() is not None for child in children)
        cleanup_errors = []
        if joined:
            for path in (temporary_root, project_root):
                if path is not None:
                    try:
                        shutil.rmtree(path)
                    except OSError as error:
                        cleanup_errors.append(str(error))
        report["owned_roots_removed"] = (
            joined
            and not cleanup_errors
            and all(
                path is None or not path.exists()
                for path in (temporary_root, project_root)
            )
        )
        report["cleanup_errors"] = cleanup_errors
        if not report["owned_roots_removed"]:
            report["status"] = "failed"
        report["elapsed_seconds"] = time.monotonic() - started
        report["finished_at_utc"] = datetime.now(UTC).isoformat()
        if report["elapsed_seconds"] > TOTAL_TIMEOUT:
            report["status"] = "failed"
            report["deadline_exceeded"] = True
        write_json(output / "result.json", report)
    print(
        json.dumps(
            {
                "status": report["status"],
                "cases": [
                    {
                        "framework": row["framework"],
                        "total_bundle_calls": row["total_bundle_calls"],
                        "status": row["status"],
                    }
                    for row in report["cases"]
                ],
                "output": str(output),
            },
            allow_nan=False,
        )
    )
    raise SystemExit(0 if report["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
