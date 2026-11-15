"""Generate a diagnostic-only React workload with a snapshot at the final GC.

The snapshot is itself a collection and changes the workload. Its observations
cannot qualify the original benchmark. Outputs are created exclusively.
"""

import sys
from pathlib import Path


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("Expected exactly one diagnostic source marker")
    return source.replace(old, new)


def workload_variant(source):
    source = replace_once(
        source,
        "import { heapStats } from 'bun:jsc'\n",
        "import * as boundaryJsc from 'bun:jsc'\nimport { heapStats } from 'bun:jsc'\n",
    )
    source = replace_once(
        source,
        "import { writeRetentionEvidence } from './retention-evidence.ts'",
        "import { cellAddress, writeRetentionEvidence } from './retention-evidence.ts'",
    )
    source = replace_once(
        source,
        "async function heapSnapshot(phase: string) {",
        "let boundarySnapshot: unknown\nasync function heapSnapshot(phase: string) {",
    )
    source = replace_once(
        source,
        "  Bun.gc(true)\n  const stats = heapStats()",
        "  if (phase.startsWith('all views disposed;')) {\n"
        "    const generate: unknown = Reflect.get(boundaryJsc, 'generateHeapSnapshotForDebugging')\n"
        "    assert(typeof generate === 'function', 'Boundary snapshot unavailable')\n"
        "    boundarySnapshot = generate()\n"
        "  } else Bun.gc(true)\n  const stats = heapStats()",
    )
    source = replace_once(
        source,
        "      await Bun.sleep(1)\n      Bun.gc(true)\n      const firstReachable",
        "      const boundaryTargets = probes.flatMap((probe, index) => {\n"
        "        const value = probe.deref()\n"
        "        return value === undefined ? [] : [{ index, ...cellAddress(value) }]\n"
        "      })\n"
        "      await Bun.sleep(1)\n      Bun.gc(true)\n      const firstReachable",
    )
    source = replace_once(
        source,
        "      const probeKinds =\n",
        "      assert(boundarySnapshot, 'Boundary snapshot missing')\n"
        "      const boundaryFile = values.output + '.boundary.json.gz'\n"
        "      const encoded = Bun.gzipSync(JSON.stringify(boundarySnapshot))\n"
        "      assert(encoded.byteLength <= 48 * 1024 * 1024, 'Boundary snapshot too large')\n"
        "      writeFileSync(boundaryFile, encoded, { flag: 'wx' })\n"
        "      writeFileSync(values.output + '.boundary-targets.json', JSON.stringify({ targets: boundaryTargets.filter(target => stillReachable.includes(target.index)) }), { flag: 'wx' })\n"
        "      const probeKinds =\n",
    )
    return source


def entry_variant(source, pin):
    source = replace_once(
        source, "from './workload.ts'", "from './.retention-boundary-workload.ts'"
    )
    if pin:
        source = replace_once(
            source,
            "  await view.ready\n",
            "  await view.ready\n  ;(globalThis as unknown as { __boundaryPin?: object }).__boundaryPin = view\n",
        )
    return source


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("baseline", "pin"):
        raise ValueError("Expected baseline|pin and output directory")
    directory = Path(sys.argv[2])
    source_dir = Path("benchmarks/solid")
    workload = workload_variant((source_dir / "workload.ts").read_text())
    entry = entry_variant((source_dir / "react.tsx").read_text(), sys.argv[1] == "pin")
    for name, text in (
        (".retention-boundary-workload.ts", workload),
        (".retention-boundary-react.tsx", entry),
    ):
        with (directory / name).open("x", encoding="utf-8", newline="\n") as output:
            output.write(text)


if __name__ == "__main__":
    main()
