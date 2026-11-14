"""Build paired React fixture variants and retain every headless observation.

Both variants wrap disposal identically. The clear variant additionally releases
its two hook dispatch references after acknowledged disposal. Neither variant is
the shipped fixture, and this does not modify its assertions or prove a root.
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


MARKER = "dispose: () => view.dispose(),"


def variant_source(source, clear):
    if source.count(MARKER) != 1:
        raise ValueError("Expected exactly one fixture dispose marker")
    clear_dispatchers = " setText = undefined!; setRows = undefined!;" if clear else ""
    return source.replace(
        MARKER, f"async dispose() {{ await view.dispose();{clear_dispatchers} }},"
    )


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    peer = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    trials = int(sys.argv[3])
    if not 1 <= trials <= 10:
        raise ValueError("Trial count must be in 1..10")
    output.mkdir(parents=True, exist_ok=False)
    fixture = Path("benchmarks/solid/react.tsx")
    source = fixture.read_text(encoding="utf-8")
    plan = {
        "originalSourceSha256": digest(source.encode()),
        "variantSourceSha256": {
            name: digest(variant_source(source, name == "clear").encode())
            for name in ("baseline", "clear")
        },
        "peerSha256": digest(peer.read_bytes()),
        "trialsPerVariant": trials,
        "ordering": "baseline then clear on even pairs; reverse on odd pairs",
        "difference": "Both use the same async dispose wrapper; clear additionally assigns undefined to both React hook setters after disposal.",
        "scope": "Headless diagnostic variants, not the actual benchmark fixture or native rendering.",
    }
    (output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    for variant in ("baseline", "clear"):
        text = variant_source(source, variant == "clear")
        # Keep the entry path identical so the source edit is the only planned
        # difference; create exclusively and remove before building the next.
        generated = fixture.parent / ".retention-dispatch-control.tsx"
        with generated.open("x", encoding="utf-8", newline="\n") as f:
            f.write(text)
        try:
            (output / f"{variant}-source.tsx.txt").write_text(text, encoding="utf-8")
            env = os.environ.copy()
            env["CONTROL_ENTRY"] = str(generated.resolve())
            env["CONTROL_OUT"] = str(output / variant)
            bundle = 'import { bundleApplication } from "./scripts/native/bundle.ts"; await bundleApplication({framework:"react",entry:process.env.CONTROL_ENTRY,outdir:process.env.CONTROL_OUT,cwd:process.cwd()})'
            subprocess.run(["bun", "-e", bundle], env=env, check=True, timeout=180)
        finally:
            generated.unlink()
        binary = output / (
            f"{variant}-aot.exe" if os.name == "nt" else f"{variant}-aot"
        )
        with (output / f"{variant}-compile.log").open("wb") as log:
            subprocess.run(
                [
                    "bun",
                    "--no-install",
                    "compile",
                    "--no-script",
                    "--production",
                    "--explain=json",
                    str(output / variant / "application.js"),
                    "--outfile",
                    str(binary),
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
                timeout=180,
            )
        inspect = 'import { inspectBunExecutable } from "./scripts/native/inspect.ts"; import { inspectBunRuntime } from "./scripts/native/inspect-runtime.ts"; const graph=inspectBunExecutable(process.argv[1]); const runtime=inspectBunRuntime(process.argv[1]); if (!graph.hasCompiledProgram || runtime.jit !== "unused") throw new Error("Not AOT"); console.log(JSON.stringify({graph,runtime},null,2))'
        with (output / f"{variant}-inspection.json").open("wb") as log:
            subprocess.run(
                ["bun", "-e", inspect, str(binary)], stdout=log, check=True, timeout=30
            )
    results = []
    invalid = 0
    for trial in range(trials):
        variants = ("baseline", "clear") if trial % 2 == 0 else ("clear", "baseline")
        for variant in variants:
            binary = output / (
                f"{variant}-aot.exe" if os.name == "nt" else f"{variant}-aot"
            )
            child_output = output / f"{trial:02}-{variant}"
            command = [
                sys.executable,
                "benchmarks/retention/headless-adapter-control.py",
                "react",
                str(peer),
                str(output / variant / "application.js"),
                str(binary),
                str(child_output),
                "1",
            ]
            summary_file = child_output / "results.json"
            try:
                child = subprocess.run(
                    command, capture_output=True, text=True, timeout=300
                )
                (output / f"{trial:02}-{variant}.stdout.txt").write_text(
                    child.stdout, encoding="utf-8"
                )
                (output / f"{trial:02}-{variant}.stderr.txt").write_text(
                    child.stderr, encoding="utf-8"
                )
                records = (
                    json.loads(summary_file.read_text())
                    if summary_file.exists()
                    else []
                )
                valid = (
                    child.returncode == 0
                    and len(records) == 2
                    and [r["mode"] for r in records] == ["development", "aot"]
                    and all(r["valid"] for r in records)
                )
                result = {
                    "trial": trial,
                    "variant": variant,
                    "valid": valid,
                    "records": records,
                }
            except (
                OSError,
                ValueError,
                KeyError,
                TypeError,
                subprocess.TimeoutExpired,
            ) as error:
                valid = False
                result = {
                    "trial": trial,
                    "variant": variant,
                    "valid": False,
                    "error": str(error),
                }
            results.append(result)
            invalid += not valid
            (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
            print(json.dumps(results[-1]), flush=True)
    if invalid:
        raise SystemExit(f"{invalid} variant pairs had infrastructure or report errors")


if __name__ == "__main__":
    main()
