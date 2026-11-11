import * as jsc from 'bun:jsc'
import { writeFileSync } from 'node:fs'

/**
 * Failure-only retaining-path evidence for the shared workload (#629).
 *
 * The workload calls this only after both collection checkpoints have produced
 * their reachable index lists. It never changes those lists, the assertion or
 * the checkpoint count, and it never throws: an evidence failure is recorded in
 * the returned summary instead.
 */

/** JSC GC-debugging snapshot: nodes are [id, size, class, flags, label, cell, wrapped]. */
export type DebugSnapshot = {
  nodes: (number | string)[]
  nodeClassNames: string[]
  edges: number[]
  edgeTypes: string[]
  edgeNames: string[]
  roots: number[]
  labels: string[]
}
export type Target = { index: number; kind: string; address: string; description: string }
type PathStep = {
  id: number
  className: string
  label: string
  address: string
  rootReasons: string[]
  /** The edge from this node to the next step, toward the target. */
  edge: string | null
}

const NODE_FIELDS = 7
const EDGE_FIELDS = 4
const ROOT_FIELDS = 3
export const PATH_LIMIT = 4
export const RETAINER_LIMIT = 32
export const VISIT_LIMIT = 500_000
/** Bounded upload: a larger compressed snapshot is described, not written. */
export const SNAPSHOT_BYTES_LIMIT = 48 * 1024 * 1024
/**
 * A WeakRef's only reference is its target, so every edge out of one is weak.
 * A FinalizationRegistry is deliberately absent: it holds each held value (and
 * its cleanup callback) strongly, so its edges stay strong owners here.
 */
const WEAK_SOURCES = new Set(['WeakRef', 'JSWeakObjectRef'])

/**
 * Canonical cell address. `jscDescribe` prints zero-padded uppercase hex on
 * Windows (`0x00000281357D3660`) while heap snapshots print `0x281357d3660`.
 */
export function normalizeAddress(text: string) {
  return /^0x[0-9a-f]+$/i.test(text) ? `0x${BigInt(text).toString(16)}` : text
}

export function cellAddress(value: object): { address: string; description: string } {
  const description = jsc.jscDescribe(value)
  const match = /: (0x[0-9a-f]+)/i.exec(description)
  if (!match?.[1]) throw new Error('jscDescribe did not report a cell address')
  return { address: normalizeAddress(match[1]), description: description.slice(0, 240) }
}

function edgeName(snapshot: DebugSnapshot, type: string, data: number) {
  if (type === 'Index') return `[${data}]`
  if (type === 'Internal') return '(internal)'
  return snapshot.edgeNames[data] ?? `#${data}`
}

/** Shortest strong retaining paths from GC roots to each target cell. */
export function analyzeSnapshot(snapshot: DebugSnapshot, targets: readonly Target[]) {
  const position = new Map<number, number>()
  const byAddress = new Map<string, number>()
  for (let offset = 0; offset < snapshot.nodes.length; offset += NODE_FIELDS) {
    const id = snapshot.nodes[offset] as number
    position.set(id, offset)
    byAddress.set(normalizeAddress(String(snapshot.nodes[offset + 5])), id)
  }
  const describe = (id: number) => {
    const offset = position.get(id)
    if (offset === undefined) return { className: '?', label: '', address: '?' }
    return {
      className: snapshot.nodeClassNames[snapshot.nodes[offset + 2] as number] ?? '?',
      label: snapshot.labels[snapshot.nodes[offset + 4] as number] ?? '',
      address: String(snapshot.nodes[offset + 5]),
    }
  }
  const rootReasons = new Map<number, string[]>()
  for (let offset = 0; offset < snapshot.roots.length; offset += ROOT_FIELDS) {
    const id = snapshot.roots[offset]!
    const reason = snapshot.labels[snapshot.roots[offset + 1]!] ?? '?'
    const reachability = snapshot.labels[snapshot.roots[offset + 2]!] ?? ''
    const text = reachability ? `${reason}: ${reachability}` : reason
    rootReasons.set(id, [...(rootReasons.get(id) ?? []), text])
  }
  const incoming = new Map<number, number[]>()
  for (let offset = 0; offset < snapshot.edges.length; offset += EDGE_FIELDS) {
    const to = snapshot.edges[offset + 1]!
    const list = incoming.get(to)
    if (list) list.push(offset)
    else incoming.set(to, [offset])
  }
  const edgeText = (offset: number) => {
    const type = snapshot.edgeTypes[snapshot.edges[offset + 2]!] ?? '?'
    return `${type} ${edgeName(snapshot, type, snapshot.edges[offset + 3]!)}`
  }
  const step = (id: number, edge: string | null): PathStep => ({
    id,
    ...describe(id),
    rootReasons: rootReasons.get(id) ?? [],
    edge,
  })

  /** Breadth-first from `start` toward roots, never through weak sources or `blocked`. */
  const rootPath = (start: number, blocked: number) => {
    const parent = new Map<number, { next: number; edge: number } | null>([[start, null]])
    const queue = [start]
    for (let head = 0; head < queue.length; head++) {
      if (head >= VISIT_LIMIT) return { path: null, truncated: true }
      const current = queue[head]!
      if (rootReasons.has(current)) {
        const path: PathStep[] = []
        for (let node: number | undefined = current; node !== undefined;) {
          const link = parent.get(node)
          path.push(step(node, link ? edgeText(link.edge) : null))
          node = link?.next
        }
        return { path, truncated: false }
      }
      for (const offset of incoming.get(current) ?? []) {
        const from = snapshot.edges[offset]!
        if (from === blocked || parent.has(from) || WEAK_SOURCES.has(describe(from).className))
          continue
        parent.set(from, { next: current, edge: offset })
        queue.push(from)
      }
    }
    return { path: null, truncated: false }
  }

  return targets.map((target) => {
    const id = byAddress.get(normalizeAddress(target.address))
    if (id === undefined) return { ...target, presentInSnapshot: false as const }
    const retainers = (incoming.get(id) ?? []).map((offset) => ({
      from: step(snapshot.edges[offset]!, edgeText(offset)),
      weak: WEAK_SOURCES.has(describe(snapshot.edges[offset]!).className),
    }))
    // One shortest root path per distinct strong owner, so independent owners
    // (for example a stale conservative root and a heap edge) are each shown.
    const paths: PathStep[][] = []
    let truncated = false
    if (rootReasons.has(id)) paths.push([step(id, null)])
    const owners = new Map<number, number>()
    for (const offset of incoming.get(id) ?? []) {
      const from = snapshot.edges[offset]!
      if (!WEAK_SOURCES.has(describe(from).className) && !owners.has(from)) owners.set(from, offset)
    }
    // Owners that a bounded search cannot connect to a root, for example
    // through hidden visitor edges the snapshot omits, are counted.
    let ownersWithoutRootPath = 0
    let searched = 0
    for (const [owner, offset] of owners) {
      if (paths.length >= PATH_LIMIT || ++searched > RETAINER_LIMIT) break
      const found = rootPath(owner, id)
      truncated ||= found.truncated
      if (!found.path) ownersWithoutRootPath++
      else
        paths.push(
          [...found.path, step(id, null)].map((entry, index, all) =>
            index === all.length - 2 ? { ...entry, edge: edgeText(offset) } : entry
          )
        )
    }
    return {
      ...target,
      presentInSnapshot: true as const,
      node: step(id, null),
      directRetainers: retainers.slice(0, RETAINER_LIMIT),
      directRetainerCount: retainers.length,
      strongRetainerCount: retainers.filter((retainer) => !retainer.weak).length,
      strongOwnerCount: owners.size,
      ownersWithoutRootPath,
      pathsFromRoots: paths,
      searchTruncated: truncated,
    }
  })
}

export function rootReasonCounts(snapshot: DebugSnapshot) {
  const counts: Record<string, number> = {}
  for (let offset = 0; offset < snapshot.roots.length; offset += ROOT_FIELDS) {
    const reason = snapshot.labels[snapshot.roots[offset + 1]!] ?? '?'
    counts[reason] = (counts[reason] ?? 0) + 1
  }
  return counts
}

function generate(): DebugSnapshot {
  const generateSnapshot: unknown = Reflect.get(jsc, 'generateHeapSnapshotForDebugging')
  if (typeof generateSnapshot !== 'function')
    throw new Error('bun:jsc generateHeapSnapshotForDebugging is unavailable')
  return generateSnapshot() as DebugSnapshot
}

export type RetentionEvidenceInput = {
  /** The workload's report path; evidence files are written beside it. */
  output: string
  probes: readonly WeakRef<object>[]
  stillReachable: readonly number[]
  probeKinds: readonly string[]
}

/**
 * Writes `<output>.retention.json` (bounded analysis) and, when it fits,
 * `<output>.retention-heap.json.gz` (the in-job debugging snapshot).
 *
 * Snapshot "same-job" is taken while the assertion's own WeakRef.deref() calls
 * still keep the targets alive (root reason of that keep-alive is recorded as
 * such). Snapshot "next-task" is taken after one timer turn, when only real
 * owners remain; a target absent there had only a transient owner.
 */
export async function writeRetentionEvidence(input: RetentionEvidenceInput) {
  const reportPath = `${input.output}.retention.json`
  const heapPath = `${input.output}.retention-heap.json.gz`
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    issue: 629,
    bunRevision: Bun.revision,
    platform: `${process.platform}-${process.arch}`,
    stillReachable: input.stillReachable,
    jscOptions: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.startsWith('BUN_JSC_'))
    ),
    meaning:
      'diagnostic only, after both unchanged checkpoints; each snapshot performs its own full collection',
  }
  const summary: Record<string, unknown> = { report: reportPath }
  try {
    const targets: Target[] = input.stillReachable.map((index) => {
      const value = input.probes[index]?.deref()
      if (value === undefined)
        return { index, kind: kindOf(input, index), address: '', description: 'collected' }
      return { index, kind: kindOf(input, index), ...cellAddress(value) }
    })
    report['targets'] = targets
    const started = performance.now()
    const sameJob = generate()
    report['sameJob'] = {
      rootReasonCounts: rootReasonCounts(sameJob),
      nodeCount: sameJob.nodes.length / NODE_FIELDS,
      targets: analyzeSnapshot(sameJob, targets),
    }
    const compressed = Bun.gzipSync(JSON.stringify(sameJob))
    if (compressed.byteLength > SNAPSHOT_BYTES_LIMIT) {
      report['heapSnapshot'] = { omitted: true, gzipBytes: compressed.byteLength }
    } else {
      try {
        writeFileSync(heapPath, compressed, { flag: 'wx' })
        summary['heapSnapshot'] = heapPath
        report['heapSnapshot'] = { path: heapPath, gzipBytes: compressed.byteLength }
      } catch (error) {
        report['heapSnapshot'] = { error: String(error), gzipBytes: compressed.byteLength }
      }
    }
    // One timer turn ends the job that kept deref() targets alive.
    await Bun.sleep(0)
    const nextTask = generate()
    report['nextTask'] = {
      rootReasonCounts: rootReasonCounts(nextTask),
      nodeCount: nextTask.nodes.length / NODE_FIELDS,
      targets: analyzeSnapshot(nextTask, targets),
    }
    report['analysisMs'] = performance.now() - started
  } catch (error) {
    report['error'] = error instanceof Error ? (error.stack ?? error.message) : String(error)
    summary['error'] = report['error']
  }
  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    summary['writeError'] = error instanceof Error ? error.message : String(error)
  }
  return summary
}

function kindOf(input: RetentionEvidenceInput, index: number) {
  const perMount = input.probeKinds.length
  return `mount ${Math.floor(index / perMount)} ${input.probeKinds[index % perMount]}`
}
