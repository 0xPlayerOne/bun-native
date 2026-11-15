"""Alternate same-runtime snapshot and normal-GC boundary controls.

This diagnostic changes the fixture, observes headless IPC and compiles with a
source-built runtime that retains JIT. It is not a release benchmark.
"""

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(command, **kwargs):
    return subprocess.run(command, check=True, timeout=300, **kwargs)


def capture_variant(source, clear):
    marker = "await this.commit(snapshot(this.root));"
    if source.count(marker) != 1:
        raise ValueError("Expected exactly one renderer capture site")
    cleanup = " completedCapture.clear();" if clear else ""
    replacement = (
        "const completedCapture = snapshot(this.root); "
        "try { await this.commit(completedCapture); } finally {" + cleanup + " }"
    )
    return source.replace(marker, replacement)


def listener_variant(source, clear):
    declaration = "  const listener = () => {"
    disposal = "    dispose: () => view.dispose(),"
    if source.count(declaration) != 1 or source.count(disposal) != 1:
        raise ValueError("Expected exactly one listener declaration and disposal")
    source = source.replace(declaration, "  let listener = () => {")
    action = " listener = undefined!;" if clear else ""
    return source.replace(
        disposal, "    async dispose() { await view.dispose();" + action + " },"
    )


def react_detach_variant(source, detach, pin):
    replacements = [
        (
            "  let rowsCreated = 0",
            "  let setAttached!: Dispatch<SetStateAction<boolean>>\n  let rowsCreated = 0",
        ),
        (
            "  function App() {\n",
            "  function App() {\n    const [attached, updateAttached] = useState(true)\n    setAttached = updateAttached\n",
        ),
        (
            '<button text="Benchmark fixture" onClick={listener} />',
            '<button text="Benchmark fixture" onClick={'
            + ("attached ? listener : undefined" if detach else "listener")
            + "} />",
        ),
        (
            "    dispose: () => view.dispose(),",
            "    async dispose() { setAttached(false); await view.flush(); await view.dispose() },",
        ),
    ]
    if pin:
        replacements.append(
            (
                "  await view.ready\n",
                "  await view.ready\n  ;(globalThis as unknown as { __listenerPin?: object }).__listenerPin = listener\n",
            )
        )
    for before, after in replacements:
        if source.count(before) != 1:
            raise ValueError("Expected exactly one React detach marker")
        source = source.replace(before, after)
    return source


def main():
    if len(sys.argv) not in (5, 6):
        raise ValueError(
            "Expected runtime, peer, output, trials and optional experiment"
        )
    runtime, peer, output = (Path(value).resolve() for value in sys.argv[1:4])
    trials = int(sys.argv[4])
    if not 1 <= trials <= 10:
        raise ValueError("Trials must be in 1..10")
    output.mkdir(parents=True, exist_ok=False)
    source_dir = Path("benchmarks/solid").resolve()
    entry = source_dir / ".retention-boundary-react.tsx"
    workload = source_dir / ".retention-boundary-workload.ts"
    experiment = sys.argv[5] if len(sys.argv) == 6 else "collection"
    if experiment == "collection":
        variants = ("baseline-gc", "baseline-snapshot", "pin-gc", "pin-snapshot")
    elif experiment == "wrapper-release":
        variants = ("baseline-gc", "release-gc", "pin-gc", "pinrelease-gc")
    elif experiment in ("capture-release", "production-capture", "production-detach"):
        variants = ("baseline-gc", "clear-gc", "pin-gc", "pinclear-gc")
    elif experiment == "listener-release":
        variants = ("baseline-gc", "clear-gc", "pin-gc", "pinclear-gc")
    else:
        raise ValueError("Unknown boundary experiment")
    plan = {
        "runtimeSha256": sha(runtime),
        "peerSha256": sha(peer),
        "trials": trials,
        "experiment": experiment,
        "variants": variants,
        "ordering": "forward on even trials; reverse on odd trials",
        "scope": (
            "Headless fixture with original GC checkpoints and verified JIT-free AOT; capture source is modified."
            if experiment in ("production-capture", "production-detach")
            else "Instrumented headless fixture; source-built compiled mode retains JIT and is not release AOT."
        ),
        "sources": {},
    }
    spec = importlib.util.spec_from_file_location(
        "boundary_snapshot_control", "benchmarks/retention/boundary-snapshot-control.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load boundary fixture generator")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    for variant in variants:
        pin, mode = variant.split("-")
        if entry.exists() or workload.exists():
            raise FileExistsError("Boundary source path is already occupied")
        created = []
        try:
            workload_text = (source_dir / "workload.ts").read_text(encoding="utf-8")
            if experiment not in ("production-capture", "production-detach"):
                workload_text = generator.workload_variant(
                    workload_text, mode == "snapshot"
                )
            if pin in ("release", "pinrelease"):
                workload_text = generator.release_wrapper_callbacks(workload_text)
            entry_text = generator.entry_variant(
                (source_dir / "react.tsx").read_text(encoding="utf-8"),
                pin.startswith("pin"),
            )
            if experiment == "listener-release":
                entry_text = listener_variant(entry_text, pin in ("clear", "pinclear"))
            if experiment == "production-detach":
                entry_text = react_detach_variant(
                    entry_text, pin in ("clear", "pinclear"), pin.startswith("pin")
                )
            for path, contents in ((workload, workload_text), (entry, entry_text)):
                with path.open("x", encoding="utf-8", newline="\n") as target:
                    created.append(path)
                    target.write(contents)
            for path in (entry, workload):
                (output / f"{variant}-{path.name}.txt").write_bytes(path.read_bytes())
            plan["sources"][variant] = {"entry": sha(entry), "workload": sha(workload)}
            env = os.environ.copy()
            env.update(BOUNDARY_ENTRY=str(entry), BOUNDARY_OUT=str(output / variant))
            run(
                [
                    "bun",
                    "-e",
                    'import { bundleApplication } from "./scripts/native/bundle.ts"; await bundleApplication({framework:"react",entry:process.env.BOUNDARY_ENTRY,outdir:process.env.BOUNDARY_OUT,cwd:process.cwd()})',
                ],
                env=env,
            )
        finally:
            for path in reversed(created):
                path.unlink()
        module = output / variant / "application.js"
        if experiment in (
            "capture-release",
            "listener-release",
            "production-capture",
            "production-detach",
        ):
            original = module.read_text(encoding="utf-8")
            module.write_text(
                capture_variant(
                    original,
                    experiment in ("listener-release", "production-detach")
                    or pin in ("clear", "pinclear"),
                ),
                encoding="utf-8",
                newline="\n",
            )
        binary = output / f"{variant}.exe"
        with (output / f"{variant}-compile.log").open("wb") as log:
            run(
                [
                    str(runtime),
                    "--no-install",
                    "compile",
                    "--no-script",
                    "--production",
                    "--explain=json",
                    str(module),
                    "--outfile",
                    str(binary),
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        expected_jit = (
            "unused"
            if experiment in ("production-capture", "production-detach")
            else "present"
        )
        inspection = 'import { inspectBunExecutable } from "./scripts/native/inspect.ts"; import { inspectBunRuntime } from "./scripts/native/inspect-runtime.ts"; if (!inspectBunExecutable(process.argv[1]).hasCompiledProgram || inspectBunRuntime(process.argv[1]).jit !== process.argv[2]) throw new Error("Unexpected compiled runtime")'
        run(["bun", "-e", inspection, str(binary), expected_jit])
        plan["sources"][variant].update(module=sha(module), executable=sha(binary))
    (output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    results = []
    for trial in range(trials):
        for variant in variants if trial % 2 == 0 else reversed(variants):
            child_dir = output / f"{trial:02}-{variant}"
            env = os.environ.copy()
            if experiment in ("production-capture", "production-detach"):
                env.pop("BUN_NATIVE_DIAG_SNAPSHOT_SAFE", None)
            else:
                env["BUN_NATIVE_DIAG_SNAPSHOT_SAFE"] = "1"
            process = subprocess.run(
                [
                    sys.executable,
                    "benchmarks/retention/headless-adapter-control.py",
                    "react",
                    str(peer),
                    str(output / variant / "application.js"),
                    str(output / f"{variant}.exe"),
                    str(child_dir),
                    "1",
                    str(runtime),
                ],
                capture_output=True,
                text=True,
                timeout=300,
                env=env,
            )
            (output / f"{trial:02}-{variant}.log").write_text(
                process.stdout + process.stderr, encoding="utf-8"
            )
            records = json.loads((child_dir / "results.json").read_text())
            valid = (
                process.returncode == 0
                and len(records) == 2
                and all(record["valid"] for record in records)
            )
            for record in records:
                mode = record["mode"]
                report = json.loads((child_dir / f"00-{mode}.json").read_text())
                observed = report["retentionObservation"]["stillReachable"]
                if experiment not in ("production-capture", "production-detach"):
                    targets = json.loads(
                        (
                            child_dir / f"00-{mode}.json.boundary-targets.json"
                        ).read_text()
                    )["targets"]
                    valid = valid and sorted(
                        target["index"] for target in targets
                    ) == sorted(observed)
                if variant.startswith("pin"):
                    valid = valid and (3 if mode == "development" else 297) in observed
                    if experiment == "production-detach":
                        valid = (
                            valid and (5 if mode == "development" else 299) in observed
                        )
                if variant.endswith("snapshot"):
                    prefix = child_dir / f"00-{mode}.json"
                    analysis = Path(str(prefix) + ".boundary-analysis.json")
                    run(
                        [
                            "bun",
                            "benchmarks/retention/conservative-snapshot-analysis.ts",
                            str(prefix) + ".boundary.json.gz",
                            str(prefix) + ".boundary-targets.json",
                            str(analysis),
                        ]
                    )
                    value = json.loads(analysis.read_text())
                    valid = valid and all(
                        target["presentInSnapshot"] for target in value["targets"]
                    )
            results.append(
                {"trial": trial, "variant": variant, "valid": valid, "records": records}
            )
            (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
            if not valid:
                raise ValueError(f"Invalid boundary control: {trial} {variant}")


if __name__ == "__main__":
    main()
