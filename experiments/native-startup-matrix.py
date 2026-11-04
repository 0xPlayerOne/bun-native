"""Fixed Linux startup counterfactuals; never a Validation / Gate substitute."""

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "startup_supervisor", ROOT / "benchmarks/bridge-pairs.py"
)
SUPERVISOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPERVISOR)


def plan():
    rows = [{"name": "original-environment", "workers": None, "cache": None}]
    orders = ((None, 1, 2), (2, 1, None), (1, None, 2))
    for block, order in enumerate(orders, 1):
        for workers in order:
            group = f"block-{block}-{workers if workers is not None else 'default'}"
            for temperature in ("empty", "reused"):
                rows.append(
                    {
                        "name": f"{group}-{temperature}",
                        "workers": workers,
                        "cache": group,
                        "cache_state": temperature,
                    }
                )
    return rows


def environment(base, case, directory, nonce):
    result = dict(base)
    if case["cache"] is not None:
        result.pop("LP_NUM_THREADS", None)
        if case["workers"] is not None:
            result["LP_NUM_THREADS"] = str(case["workers"])
        result["MESA_SHADER_CACHE_DIR"] = str(directory)
        result["XDG_CACHE_HOME"] = str(directory)
    result.update(
        BUN_NATIVE_STARTUP_TRACE="1",
        BUN_NATIVE_STARTUP_LOG="1",
        BUN_NATIVE_EVIDENCE_LOG=str(directory.parent / f"{nonce}.jsonl"),
        BUN_NATIVE_EVIDENCE_NONCE=nonce,
    )
    return result


def observations(path, nonce):
    if not path.exists():
        return {"records": 0, "missing": True}
    if path.stat().st_size > 4_194_304:
        raise ValueError("Startup evidence exceeds its bound")
    records = [json.loads(line) for line in path.read_text().splitlines()]
    if any(not isinstance(row, dict) or row.get("nonce") != nonce for row in records):
        raise ValueError("Foreign startup evidence")
    selected = [
        row
        for row in records
        if row.get("stage") in ("startup-log", "startup-diagnostic")
    ]
    first = [
        row
        for row in selected
        if row.get("source") == "native" and row.get("request_id") == 3
    ]
    phases = {row["phase"]: int(row["elapsed_ns"]) for row in first}
    duration = None
    if "open_window_enter" in phases and "open_window_returned" in phases:
        duration = (
            phases["open_window_returned"] - phases["open_window_enter"]
        ) / 1_000_000
        if duration < 0:
            raise ValueError("Native phase clock moved backwards")
    return {
        "records": len(records),
        "first_open_phases": list(phases),
        "first_open_native_ms": duration,
        "trace": selected,
    }


def cache_inventory(directory):
    files = [path for path in directory.rglob("*") if path.is_file()]
    if len(files) > 10_000:
        raise ValueError("Driver cache inventory exceeds its bound")
    return {"files": len(files), "bytes": sum(path.stat().st_size for path in files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--host", type=Path, required=True)
    parser.add_argument("--bun", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Actual native collection requires Linux")
    output, host, bun = (
        path.resolve(strict=True) for path in (args.output, args.host, args.bun)
    )
    if any(output.iterdir()):
        parser.error("Use a new empty evidence directory")
    SUPERVISOR.DRIVER.enable_subreaper()
    pins = json.loads((ROOT / "toolchain.json").read_text())
    revision = SUPERVISOR.small_command([str(bun), "--revision"], ROOT)
    if revision != pins["bun"]["cliRevision"]:
        raise ValueError("Wrong Bun revision")
    source = SUPERVISOR.small_command(["git", "rev-parse", "HEAD"], ROOT)
    fixture = ROOT / "tests/native/lifecycle.ts"
    identity = {
        "source": source,
        "bun": revision,
        "host": SUPERVISOR.BASELINE.fingerprint(host),
        "fixture": SUPERVISOR.BASELINE.fingerprint(fixture),
        "controller": SUPERVISOR.BASELINE.fingerprint(Path(__file__)),
        "supervisor": SUPERVISOR.BASELINE.fingerprint(
            ROOT / "benchmarks/bridge-pairs.py"
        ),
        "machine": SUPERVISOR.BASELINE.machine_metadata(),
    }
    for filename in ("/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/cpuset.cpus.effective"):
        path = Path(filename)
        identity[filename] = path.read_text()[:1024] if path.exists() else None
    rows = plan()
    SUPERVISOR.write_json(
        output / "plan.json",
        {
            "identity": identity,
            "trials": rows,
            "attempts_per_row": 1,
            "scope": "Diagnostic only. Fixed request 5000 ms and outer 45 s; no changed source, retry, warmup hidden from the plan, or accepted performance claim.",
            "cache": "Driver cache only; OS page cache, CPU contention and host power uncontrolled. Reused row follows its declared empty-cache observation even if that observation failed.",
            "inherited_environment": {
                key: os.environ.get(key)
                for key in (
                    "LP_NUM_THREADS",
                    "MESA_SHADER_CACHE_DIR",
                    "MESA_SHADER_CACHE_DISABLE",
                    "XDG_CACHE_HOME",
                )
            },
        },
    )
    outcomes = []
    try:
        for index, case in enumerate(rows):
            directory = output / case["name"]
            directory.mkdir()
            cache = output / "caches" / (case["cache"] or "original-unused")
            if case.get("cache_state") != "reused":
                cache.mkdir(parents=True, exist_ok=False)
            before = cache_inventory(cache)
            if case.get("cache_state") == "empty" and before["files"]:
                raise ValueError("Declared empty driver cache is not empty")
            nonce = f"startup-matrix-{index:02d}"
            env = environment(os.environ, case, cache, nonce)
            env["BUN_NATIVE_HOST"] = str(host)
            env["BUN_NATIVE_EVIDENCE_LOG"] = str(directory / "events.jsonl")
            command = [
                "xvfb-run",
                "--auto-servernum",
                "--server-args=-screen 0 1280x800x24 -nolisten tcp",
                "dbus-run-session",
                "--",
                "bash",
                "scripts/quality/native-linux-session.sh",
                str(directory / "session"),
                "--",
                str(bun),
                "tests/native/lifecycle.ts",
            ]
            report = SUPERVISOR.run_owned(
                command,
                ROOT,
                directory / "process",
                45,
                expected_host=host,
                environment=env,
            )
            trace = observations(directory / "events.jsonl", nonce)
            outcome = {
                "case": case,
                "status": report["status"],
                "error": report.get("error"),
                "elapsed_seconds": report["elapsed_seconds"],
                "cleanup": report.get("cleanup"),
                "cache_before": before,
                "cache_after": cache_inventory(cache),
                "first_open_native_ms": trace.get("first_open_native_ms"),
                "first_open_phases": trace.get("first_open_phases"),
                "load_average_before": report["load_average_before"],
            }
            SUPERVISOR.write_json(directory / "startup-observations.json", trace)
            outcomes.append(outcome)
            SUPERVISOR.write_json(output / "outcomes.json", outcomes)
            print(json.dumps(outcome), flush=True)
            if (
                SUPERVISOR.BASELINE.fingerprint(host) != identity["host"]
                or SUPERVISOR.BASELINE.fingerprint(fixture) != identity["fixture"]
            ):
                raise ValueError("Measured source or host changed")
    finally:
        SUPERVISOR.write_json(output / "outcomes.json", outcomes)
    if len(outcomes) != len(rows):
        raise ValueError("Incomplete fixed experiment")
    print(
        json.dumps(
            {
                "collection": "complete",
                "trials": len(outcomes),
                "failed": sum(row["status"] != "passed" for row in outcomes),
                "qualification": False,
            }
        )
    )


if __name__ == "__main__":
    main()
