/**
 * Core and runtime commit path micro benchmark.
 *
 * Runs the application-side work of one acknowledged commit in process: the
 * core `Transaction` build (element normalization), its `validate`, the
 * runtime's `parseCommand` revalidation and `encodeFrame`, then the commit and
 * the window's listener bookkeeping. No host, IPC or native work.
 *
 *   bun benchmarks/core/commit.ts [samples]
 */
import {
  DEFAULT_LIMITS,
  encodeFrame,
  parseCommand,
  REQUIRED_CAPABILITIES,
  type Capability,
} from '@bun-native/protocol'
import { EventBindings } from '../../packages/core/src/events.ts'
import {
  CommittedText,
  makeNode,
  Transaction,
  type NodeState,
} from '../../packages/core/src/tree.ts'

function nanoseconds(): number {
  return Number(process.hrtime.bigint())
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}

const capabilities: readonly Capability[] = [
  ...REQUIRED_CAPABILITIES,
  'split_v1',
  'style_decoration_v1',
  'overlays_v1',
  'accessibility_v1',
  'accessibility_lists_v1',
]
const limits = { ...DEFAULT_LIMITS }
const rowStyle = { direction: 'row', gap: 4, padding: 2, align_items: 'center' } as const
const labelStyle = { color: 0x20_20_20, font_size: 13, flex_grow: 1 }
const mountRows = 42
const windowRows = 1_000

let nextId = 1
const allocate = () => nextId++

function window() {
  const nodes = new Map<number, NodeState>()
  const root = makeNode(allocate(), { kind: 'box' })
  nodes.set(root.id, root)
  return { nodes, root, text: new CommittedText(limits.max_text_bytes, [root]) }
}

function transaction(target: ReturnType<typeof window>) {
  return new Transaction(target.nodes, target.root.id, allocate, limits, capabilities, target.text)
}

function batch(operations: unknown) {
  return parseCommand({ id: 1, type: 'batch', window_id: 1, base_revision: 0, operations })
}

// A committed window of `windowRows` rows, each label bound to a click listener.
const large = window()
{
  const build = transaction(large)
  for (let row = 0; row < windowRows; row += 1) {
    const box = build.create({ kind: 'box', style: rowStyle })
    build.append(box, build.create({ kind: 'text', text: 'Row ' + row, style: labelStyle }))
    build.append(large.root.handle, box)
  }
  build.validate()
  build.commit(large.nodes, large.text)
}
const labels = [...large.nodes.values()].filter((node) => node.element.kind === 'text')
const listeners = new EventBindings(() => {})
for (const label of labels) listeners.register(label.id, label.handle, 'click', () => {})

type Phases = Record<string, number>

/** A `mountRows`-row `box > [text, button]` mount into an empty window (252 operations). */
function mount(): Phases {
  const target = window()
  const start = nanoseconds()
  const build = transaction(target)
  for (let row = 0; row < mountRows; row += 1) {
    const box = build.create({ kind: 'box', style: rowStyle })
    build.append(box, build.create({ kind: 'text', text: 'Message ' + row, style: labelStyle }))
    build.append(box, build.create({ kind: 'button', text: 'Archive', style: {} }))
    build.append(target.root.handle, box)
  }
  const built = nanoseconds()
  build.validate()
  const validated = nanoseconds()
  const command = batch(build.operations)
  const parsed = nanoseconds()
  encodeFrame(command)
  const encoded = nanoseconds()
  return {
    build: built - start,
    validate: validated - built,
    parseCommand: parsed - validated,
    encodeFrame: encoded - parsed,
    total: encoded - start,
  }
}

/** One text `set` in the committed window, then its commit and listener bookkeeping. */
function keystroke(sample: number): Phases {
  const label = labels[sample % labels.length]!
  const start = nanoseconds()
  const build = transaction(large)
  build.set(label.handle as never, { kind: 'text', text: 'Edited ' + sample, style: labelStyle })
  build.validate()
  const built = nanoseconds()
  encodeFrame(batch(build.operations))
  const sent = nanoseconds()
  build.commit(large.nodes, large.text)
  const committed = nanoseconds()
  listeners.forget(build.nodes.deletes)
  const forgotten = nanoseconds()
  return {
    core: built - start,
    runtime: sent - built,
    commit: committed - sent,
    listeners: forgotten - committed,
    total: forgotten - start,
  }
}

function measure(name: string, run: (sample: number) => Phases, samples: number) {
  for (let sample = 0; sample < 300; sample += 1) run(sample)
  Bun.gc(true)
  const phases: Record<string, number[]> = {}
  for (let sample = 0; sample < samples; sample += 1)
    for (const [phase, elapsed] of Object.entries(run(sample))) (phases[phase] ??= []).push(elapsed)
  const us = (value: number) => Number((value / 1e3).toFixed(3))
  return Object.entries(phases).map(([phase, timings]) => {
    const sorted = timings.toSorted((left, right) => left - right)
    return {
      scenario: name,
      phase,
      samples,
      p50Us: us(percentile(sorted, 0.5)),
      p95Us: us(percentile(sorted, 0.95)),
    }
  })
}

const samples = Number(process.argv[2] ?? 3000)
console.log(
  JSON.stringify(
    {
      bun: Bun.revision,
      platform: process.platform,
      arch: process.arch,
      mountRows,
      windowRows,
      listeners: listeners.size,
      results: [...measure('mount', mount, samples), ...measure('keystroke', keystroke, samples)],
    },
    null,
    2
  )
)
