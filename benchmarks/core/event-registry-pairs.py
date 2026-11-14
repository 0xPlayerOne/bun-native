#!/usr/bin/env python3
"""Compare the event fast path against an otherwise identical source copy."""

import hashlib
import json
import math
import platform
import statistics
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MARKER = "    if (this.nodes.size === 0) return\n"
SCENARIOS = {"empty", "off-path", "target", "mixed"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    output = Path(sys.argv[1]).resolve()
    pairs = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    if not 1 <= pairs <= 20:
        raise ValueError("pairs must be between 1 and 20")
    output.mkdir(parents=True, exist_ok=True)
    candidate = (ROOT / "packages/core/src/events.ts").read_text()
    probe = (ROOT / "benchmarks/core/event-registry-pair-probe.ts.txt").read_text()
    if candidate.count(MARKER) != 1 or probe.count("EVENTS_FILE") != 1:
        raise ValueError("expected exactly one source marker and probe placeholder")
    sources = {"baseline": candidate.replace(MARKER, "", 1), "candidate": candidate}
    created = []
    results = {
        "environment": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "bun": subprocess.check_output(["bun", "--version"], text=True).strip(),
            "sourceSha256": {k: sha(v.encode()) for k, v in sources.items()},
            "probeSha256": sha(probe.encode()),
            "pairs": pairs,
        },
        "runs": [],
    }

    def run(command, log):
        proc = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
        (output / log).write_text(proc.stdout + "\n--- stderr ---\n" + proc.stderr)
        if proc.returncode:
            raise RuntimeError(f"{command[0]} failed: {log}")
        return proc.stdout

    revision = subprocess.check_output(
        ["bun", "-e", "console.log(Bun.revision)"], text=True
    ).strip()
    results["environment"]["revision"] = revision
    (output / "raw.json").write_text(json.dumps(results, indent=2) + "\n")
    try:
        for variant, source in sources.items():
            event_file = ROOT / f"packages/core/src/.event-pair-{variant}.ts"
            probe_file = ROOT / f"benchmarks/core/.event-pair-{variant}.ts"
            for filename, content in [
                (event_file, source),
                (probe_file, probe.replace("EVENTS_FILE", event_file.name)),
            ]:
                with filename.open("x") as handle:
                    created.append(filename)
                    handle.write(content)
            binary = output / f"{variant}-aot"
            run(
                [
                    "bun",
                    "--no-install",
                    "build",
                    "--compile",
                    "--aot",
                    "--no-script",
                    "--production",
                    "--explain=json",
                    str(probe_file),
                    "--outfile",
                    str(binary),
                ],
                f"{variant}-compile.log",
            )
            inspect = 'import { inspectBunExecutable } from "./scripts/native/inspect.ts"; import { inspectBunRuntime } from "./scripts/native/inspect-runtime.ts"; const graph=inspectBunExecutable(process.argv[1]); const runtime=inspectBunRuntime(process.argv[1]); if (!graph.hasCompiledProgram || runtime.jit !== "unused") throw new Error("Not AOT"); console.log(JSON.stringify({graph,runtime},null,2))'
            run(["bun", "-e", inspect, str(binary)], f"{variant}-inspection.log")
            results["environment"][f"{variant}BinarySha256"] = sha(binary.read_bytes())
        for mode in ["development", "aot"]:
            for pair in range(pairs):
                order = (
                    ["baseline", "candidate"]
                    if pair % 2 == 0
                    else ["candidate", "baseline"]
                )
                for variant in order:
                    command = (
                        ["bun", str(ROOT / f"benchmarks/core/.event-pair-{variant}.ts")]
                        if mode == "development"
                        else [str(output / f"{variant}-aot")]
                    )
                    data = json.loads(run(command, f"{mode}-{pair:02d}-{variant}.log"))
                    if data["revision"] != revision:
                        raise ValueError("unexpected Bun revision")
                    entries = data["results"]
                    if {entry["scenario"] for entry in entries} != SCENARIOS or len(
                        entries
                    ) != len(SCENARIOS):
                        raise ValueError("invalid scenarios")
                    for entry in entries:
                        samples = entry["samplesNs"]
                        if len(samples) != 25 or any(
                            not isinstance(x, (int, float))
                            or not math.isfinite(x)
                            or x <= 0
                            for x in samples
                        ):
                            raise ValueError("invalid samples")
                        if entry["medianNs"] != statistics.median(samples):
                            raise ValueError("invalid median")
                    results["runs"].append(
                        {"mode": mode, "pair": pair, "variant": variant, "data": data}
                    )
                    (output / "raw.json").write_text(
                        json.dumps(results, indent=2) + "\n"
                    )
    finally:
        for filename in reversed(created):
            filename.unlink()


if __name__ == "__main__":
    main()
