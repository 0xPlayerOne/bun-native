/**
 * Protocol encode/decode micro benchmark for realistic app traffic.
 *
 * Runs the same calls the runtime makes per message, in process and without
 * IPC: commands out are `parseCommand` then `encodeFrame`; events in are
 * `FrameDecoder.push` over one pipe chunk then `parseEvent` per frame. Each
 * phase is timed separately so the slow validator or framing step stands out.
 *
 *   bun benchmarks/protocol/roundtrip.ts [samples]
 */
import { encodeFrame, FrameDecoder, parseCommand, parseEvent } from '@bun-native/protocol'

function nanoseconds(): number {
  return Number(process.hrtime.bigint())
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}

const rowStyle = {
  direction: 'row',
  gap: 4,
  padding: 2,
  align_items: 'center',
}
const labelStyle = { color: 0x202020, font_size: 13, flex_grow: 1 }

/** A full 256-operation mount batch: rows of box > [text, button], then inserts. */
function mountBatch(): Record<string, unknown> {
  const operations: Record<string, unknown>[] = []
  let node = 2
  while (operations.length + 6 <= 256) {
    const box = node++
    const text = node++
    const button = node++
    operations.push(
      {
        type: 'create',
        node_id: box,
        element: { kind: 'box', style: rowStyle },
      },
      {
        type: 'create',
        node_id: text,
        element: {
          kind: 'text',
          text: 'Inbox message ' + text,
          style: labelStyle,
        },
      },
      {
        type: 'create',
        node_id: button,
        element: {
          kind: 'button',
          text: 'Archive',
          disabled: false,
          style: {},
        },
      },
      { type: 'insert', parent_id: box, child_id: text, index: 0 },
      { type: 'insert', parent_id: box, child_id: button, index: 1 },
      { type: 'insert', parent_id: 1, child_id: box, index: box }
    )
  }
  return { type: 'batch', window_id: 1, base_revision: 7, operations }
}

/** One keystroke's update: the input value and a dependent label. */
function keystrokeBatch(): Record<string, unknown> {
  return {
    type: 'batch',
    window_id: 1,
    base_revision: 8,
    operations: [
      {
        type: 'set',
        node_id: 40,
        element: {
          kind: 'input',
          value: 'search term',
          placeholder: 'Search',
          style: {},
        },
        expected_input_revision: 3,
      },
      {
        type: 'set',
        node_id: 41,
        element: {
          kind: 'text',
          text: '12 results for "search term"',
          style: labelStyle,
        },
      },
    ],
  }
}

/** One large text node set: a 12,000 character log view. */
function largeTextBatch(): Record<string, unknown> {
  const line = 'INFO  12:00:00.000 request completed in 3 ms\n'
  return {
    type: 'batch',
    window_id: 1,
    base_revision: 9,
    operations: [
      {
        type: 'set',
        node_id: 50,
        element: {
          kind: 'text',
          text: line.repeat(Math.floor(12_000 / line.length)),
        },
      },
    ],
  }
}

const modifiers = {
  control: false,
  alt: false,
  shift: false,
  platform: false,
  function: false,
}
const path = [1, 4, 9, 16, 40]
const route = { window_id: 1, node_id: 40, tree_revision: 8, path }

/** One pipe chunk of typical input traffic: pointer, keys, input, acks. */
function eventChunk(): Uint8Array {
  const events: Record<string, unknown>[] = []
  let sequence = 1
  for (let index = 0; index < 8; index += 1) {
    events.push(
      {
        type: 'pointer_down',
        sequence: sequence++,
        ...route,
        button: 'left',
        x: 120.5,
        y: 48,
        modifiers,
      },
      {
        type: 'pointer_up',
        sequence: sequence++,
        ...route,
        button: 'left',
        x: 120.5,
        y: 48,
        modifiers,
      },
      { type: 'click', sequence: sequence++, ...route },
      {
        type: 'key_down',
        sequence: sequence++,
        ...route,
        key: 'a',
        key_char: 'a',
        modifiers,
      },
      {
        type: 'input',
        sequence: sequence++,
        ...route,
        value: 'search term',
        input_revision: index,
      },
      { type: 'key_up', sequence: sequence++, ...route, key: 'a', modifiers },
      {
        type: 'applied',
        id: index + 1,
        window_id: 1,
        tree_revision: index + 9,
      }
    )
  }
  return new TextEncoder().encode(events.map((event) => JSON.stringify(event) + '\n').join(''))
}

type Result = {
  scenario: string
  phase: string
  samples: number
  meanUs: number
  p50Us: number
  p95Us: number
}

function measure(scenario: string, phase: string, samples: number, run: () => unknown): Result {
  for (let index = 0; index < 200; index += 1) run()
  Bun.gc(true)
  const timings: number[] = []
  let total = 0
  for (let index = 0; index < samples; index += 1) {
    const start = nanoseconds()
    run()
    const elapsed = nanoseconds() - start
    timings.push(elapsed)
    total += elapsed
  }
  const sorted = timings.toSorted((left, right) => left - right)
  const us = (value: number) => Number((value / 1e3).toFixed(3))
  return {
    scenario,
    phase,
    samples,
    meanUs: us(total / samples),
    p50Us: us(percentile(sorted, 0.5)),
    p95Us: us(percentile(sorted, 0.95)),
  }
}

const samples = Number(process.argv[2] ?? 2000)
const results: Result[] = []
let id = 1
for (const [scenario, build] of [
  ['mount', mountBatch],
  ['keystroke', keystrokeBatch],
  ['large-text', largeTextBatch],
] as const) {
  const input = build()
  const command = parseCommand({ ...input, id })
  results.push(
    measure(scenario, 'parseCommand', samples, () => parseCommand({ ...input, id: id++ }))
  )
  results.push(measure(scenario, 'encodeFrame', samples, () => encodeFrame(command)))
}
const chunk = eventChunk()
const frames = new FrameDecoder().push(chunk)
if (frames.length !== 56) throw new Error('Unexpected frame count ' + frames.length)
results.push(measure('events', 'FrameDecoder.push', samples, () => new FrameDecoder().push(chunk)))
results.push(
  measure('events', 'parseEvent', samples, () => {
    for (const frame of frames) parseEvent(frame)
  })
)
console.log(
  JSON.stringify(
    {
      bun: Bun.revision,
      platform: process.platform,
      arch: process.arch,
      chunkBytes: chunk.byteLength,
      results,
    },
    null,
    2
  )
)
