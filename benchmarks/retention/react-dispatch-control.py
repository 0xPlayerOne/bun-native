"""Build React retention controls and retain every headless observation.

Both variants wrap disposal identically. The clear variant additionally releases
its two hook dispatch references after acknowledged disposal. Other modes probe
shutdown and lifecycle-local ownership with deliberately pinned controls. These
variants are not the shipped fixture and do not change its assertions or prove a root.
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


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("Expected exactly one diagnostic source marker")
    return source.replace(old, new)


def shutdown_workload(source):
    source = replace_once(
        source,
        "  let failure: unknown\n",
        "  let failure: unknown\n  let diagnosticProbes: WeakRef<object>[] | undefined\n",
    )
    source = replace_once(
        source,
        "      if (stillReachable.length > 0)\n        result['retentionEvidence']",
        "      if (stillReachable.length > 0) diagnosticProbes = probes\n      if (stillReachable.length > 0)\n        result['retentionEvidence']",
    )
    source = replace_once(
        source,
        "  } finally {\n    for (const cleanup of [",
        "  } finally {\n    if (diagnosticProbes) { await Bun.sleep(1); Bun.gc(true); result['beforeShutdownDiagnostic'] = diagnosticProbes.flatMap((probe, index) => probe.deref() === undefined ? [] : [index]) }\n    for (const cleanup of [",
    )
    return replace_once(
        source,
        "    result['cleanup'] = application?.diagnostics ?? null",
        "    if (diagnosticProbes) { await Bun.sleep(1); Bun.gc(true); result['afterShutdownDiagnostic'] = diagnosticProbes.flatMap((probe, index) => probe.deref() === undefined ? [] : [index]) }\n    result['cleanup'] = application?.diagnostics ?? null",
    )


def shutdown_entry(source, pin):
    source = replace_once(
        source, "from './workload.ts'", "from './.retention-post-workload.ts'"
    )
    if pin:
        source = replace_once(
            source,
            "  await view.ready\n",
            "  await view.ready\n  ;(globalThis as unknown as { __retentionDiagnosticPin?: object }).__retentionDiagnosticPin = view\n",
        )
    return source


def shutdown_record_valid(raw, mode, pin):
    if raw["status"] == "passed":
        return not pin
    limit = 6 if mode == "development" else 300
    for key in ("beforeShutdownDiagnostic", "afterShutdownDiagnostic"):
        indexes = raw.get(key)
        if not isinstance(indexes, list) or any(
            type(index) is not int or not 0 <= index < limit for index in indexes
        ):
            return False
    if pin:
        expected = 3 if mode == "development" else 297
        return all(
            expected in indexes
            for indexes in (
                raw["retentionObservation"]["stillReachable"],
                raw["beforeShutdownDiagnostic"],
                raw["afterShutdownDiagnostic"],
            )
        )
    return True


def cycle_workload(source, variant):
    if variant not in ("baseline", "clear", "pin"):
        raise ValueError("Unknown cycle control variant")
    source = replace_once(
        source,
        "        const view = await mount(window, initial)\n",
        "        let view: MeasuredView | undefined = await mount(window, initial)\n",
    )
    action = {
        "baseline": "",
        "clear": "        view = undefined\n",
        "pin": "        ;(globalThis as unknown as { __cycleDiagnosticPin?: object }).__cycleDiagnosticPin = view\n",
    }[variant]
    return replace_once(
        source,
        "        return view.probes\n",
        "        const cycleProbes = view.probes\n"
        + action
        + "        return cycleProbes\n",
    )


def cycle_pin_valid(raw, mode):
    expected = 3 if mode == "development" else 297
    return (
        raw["status"] == "failed"
        and expected in raw["retentionObservation"]["stillReachable"]
    )


def first_observation_workload(source, omit):
    original = (
        "      const firstReachable = probes.flatMap((probe, index) =>\n"
        "        probe.deref() === undefined ? [] : [index]\n"
        "      )\n"
    )
    if not omit:
        if source.count(original) != 1:
            raise ValueError("Expected exactly one first observation")
        return source
    return replace_once(source, original, "      const firstReachable: number[] = []\n")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save_variant(path, text):
    path.write_text(text, encoding="utf-8", newline="\n")


def control_command(peer, module, binary, output, runtime):
    command = [
        sys.executable,
        "benchmarks/retention/headless-adapter-control.py",
        "react",
        str(peer),
        str(module),
        str(binary),
        str(output),
        "1",
    ]
    if runtime is not None:
        command.append(runtime)
    return command


def main():
    peer = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    trials = int(sys.argv[3])
    kind = sys.argv[4] if len(sys.argv) > 4 else "dispatch"
    runtime = sys.argv[5] if len(sys.argv) > 5 else None
    if kind not in ("dispatch", "shutdown", "cycle", "first-observation"):
        raise ValueError("Unknown control kind")
    if not 1 <= trials <= 10:
        raise ValueError("Trial count must be in 1..10")
    output.mkdir(parents=True, exist_ok=False)
    fixture = Path("benchmarks/solid/react.tsx")
    source = fixture.read_text(encoding="utf-8")
    workload_path = fixture.parent / "workload.ts"
    original_workload = (
        workload_path.read_text(encoding="utf-8")
        if kind in ("shutdown", "cycle", "first-observation")
        else None
    )
    variants = (
        ("baseline", "pin")
        if kind == "shutdown"
        else ("baseline", "clear", "pin")
        if kind == "cycle"
        else ("baseline", "omit-first", "pin-baseline", "pin-omit-first")
        if kind == "first-observation"
        else ("baseline", "clear")
    )
    workloads = {
        name: shutdown_workload(original_workload)
        if kind == "shutdown"
        else cycle_workload(original_workload, name)
        if kind == "cycle"
        else first_observation_workload(original_workload, name.endswith("omit-first"))
        if kind == "first-observation"
        else None
        for name in variants
    }
    sources = {
        name: (
            shutdown_entry(
                source,
                (kind == "shutdown" and name == "pin")
                or (kind == "first-observation" and name.startswith("pin-")),
            )
            if kind in ("shutdown", "cycle", "first-observation")
            else variant_source(source, name == "clear")
        )
        for name in variants
    }
    plan = {
        "kind": kind,
        "originalSourceSha256": digest(source.encode()),
        "originalSourceFileSha256": digest(fixture.read_bytes()),
        "originalWorkloadSha256": digest(original_workload.encode())
        if original_workload
        else None,
        "originalWorkloadFileSha256": digest(workload_path.read_bytes())
        if original_workload
        else None,
        "variantSourceSha256": {
            name: digest(text.encode()) for name, text in sources.items()
        },
        "instrumentedWorkloadSha256": (
            {name: digest(text.encode()) for name, text in workloads.items()}
            if kind in ("cycle", "first-observation")
            else digest(workloads["baseline"].encode())
            if kind == "shutdown"
            else None
        ),
        "peerSha256": digest(peer.read_bytes()),
        "trialsPerVariant": trials,
        "ordering": (
            f"{variants} on even pairs; reverse on odd pairs"
            if kind in ("cycle", "first-observation")
            else f"{variants[0]} then {variants[1]} on even pairs; reverse on odd pairs"
        ),
        "difference": (
            "Both collect after failure before and after application shutdown; pin deliberately holds the latest root globally."
            if kind == "shutdown"
            else "Clear explicitly releases the cycle local after copying probes; pin holds that view globally as a positive control."
            if kind == "cycle"
            else "Omit-first skips only the diagnostic first dereference; pinned variants retain the latest render root globally."
            if kind == "first-observation"
            else "Both use the same async dispose wrapper; clear additionally assigns undefined to both React hook setters after disposal."
        ),
        "scope": "Headless diagnostic variants, not the actual benchmark fixture or native rendering.",
    }
    (output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    for variant in variants:
        text = sources[variant]
        # Keep the entry path identical so the source edit is the only planned
        # difference; create exclusively and remove before building the next.
        generated = fixture.parent / ".retention-dispatch-control.tsx"
        created = []
        try:
            workload = workloads[variant]
            if workload is not None:
                temporary_workload = fixture.parent / ".retention-post-workload.ts"
                with temporary_workload.open("x", encoding="utf-8", newline="\n") as f:
                    created.append(temporary_workload)
                    f.write(workload)
                workload_name = (
                    f"{variant}-instrumented-workload.ts.txt"
                    if kind in ("cycle", "first-observation")
                    else "instrumented-workload.ts.txt"
                )
                save_variant(output / workload_name, workload)
            with generated.open("x", encoding="utf-8", newline="\n") as f:
                created.append(generated)
                f.write(text)
            save_variant(output / f"{variant}-source.tsx.txt", text)
            env = os.environ.copy()
            env["CONTROL_ENTRY"] = str(generated.resolve())
            env["CONTROL_OUT"] = str(output / variant)
            bundle = 'import { bundleApplication } from "./scripts/native/bundle.ts"; await bundleApplication({framework:"react",entry:process.env.CONTROL_ENTRY,outdir:process.env.CONTROL_OUT,cwd:process.cwd()})'
            subprocess.run(["bun", "-e", bundle], env=env, check=True, timeout=180)
        finally:
            for path in reversed(created):
                path.unlink()
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
        order = variants if trial % 2 == 0 else tuple(reversed(variants))
        for variant in order:
            binary = output / (
                f"{variant}-aot.exe" if os.name == "nt" else f"{variant}-aot"
            )
            child_output = output / f"{trial:02}-{variant}"
            command = control_command(
                peer, output / variant / "application.js", binary, child_output, runtime
            )
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
                if valid and kind == "shutdown":
                    for record in records:
                        raw = json.loads(
                            (child_output / f"00-{record['mode']}.json").read_text()
                        )
                        valid = valid and shutdown_record_valid(
                            raw, record["mode"], variant == "pin"
                        )
                if valid and kind == "cycle" and variant == "pin":
                    for record in records:
                        raw = json.loads(
                            (child_output / f"00-{record['mode']}.json").read_text()
                        )
                        valid = valid and cycle_pin_valid(raw, record["mode"])
                if valid and kind == "first-observation":
                    for record in records:
                        raw = json.loads(
                            (child_output / f"00-{record['mode']}.json").read_text()
                        )
                        if variant.endswith("omit-first"):
                            valid = (
                                valid
                                and raw["retentionObservation"]["firstReachable"] == []
                            )
                        if variant.startswith("pin-"):
                            valid = valid and cycle_pin_valid(raw, record["mode"])
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
        raise SystemExit(
            f"{invalid} variant trials had infrastructure or report errors"
        )


if __name__ == "__main__":
    main()
