/**
 * Core event delivery fan-out micro benchmark.
 *
 * Drives the window's listener registry (`EventBindings.prepare`) and
 * `dispatchPlan` exactly as an application window does for one routed native
 * event, in process: no host, IPC, protocol parse or path ownership checks.
 * Each sample prepares, dispatches and releases one event.
 *
 *   bun benchmarks/core/events.ts [samples]
 */
import type { NativeNode } from '@bun-native/core'
import { dispatchPlan, EventBindings, type RoutedEvent } from '../../packages/core/src/events.ts'

function nanoseconds(): number {
  return Number(process.hrtime.bigint())
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}

const depth = 8
const modifiers = {
  control: false,
  alt: false,
  shift: false,
  platform: false,
  function: false,
}
const handle = (id: number) => ({ id }) as unknown as NativeNode
const ids = Array.from({ length: depth }, (_, index) => index + 1)
const path = ids.map(handle)
const route = (type: string) => ({
  type,
  sequence: 1,
  window_id: 1,
  node_id: ids.at(-1)!,
  tree_revision: 1,
  path: ids,
})
const events = {
  click: route('click'),
  key_down: { ...route('key_down'), key: 'a', key_char: 'a', modifiers },
  pointer_down: {
    ...route('pointer_down'),
    button: 'left',
    x: 10,
    y: 20,
    modifiers,
  },
  input: { ...route('input'), value: 'search term', input_revision: 1 },
} as unknown as Record<string, RoutedEvent>

type Setup = (bindings: EventBindings, delivered: { count: number }) => void
const listen = (delivered: { count: number }) => (): void => {
  delivered.count += 1
}

/** Scenario name, event type, expected deliveries per event and listener layout. */
const scenarios: [string, string, number, Setup][] = [
  ['no-listener', 'pointer_down', 0, () => {}],
  [
    'target',
    'click',
    1,
    (bindings, delivered) => bindings.register(depth, path.at(-1)!, 'click', listen(delivered)),
  ],
  [
    'ancestor-bubble',
    'key_down',
    1,
    (bindings, delivered) => bindings.register(2, path[1]!, 'key_down', listen(delivered)),
  ],
  [
    'every-level',
    'click',
    depth * 2,
    (bindings, delivered) => {
      for (let index = 0; index < depth; index += 1) {
        bindings.register(index + 1, path[index]!, 'click', listen(delivered))
        bindings.register(index + 1, path[index]!, 'click', listen(delivered), {
          capture: true,
        })
      }
    },
  ],
  [
    'input-async',
    'input',
    1,
    (bindings, delivered) =>
      bindings.register(depth, path.at(-1)!, 'input', async () => {
        delivered.count += 1
      }),
  ],
]

async function measure(
  name: string,
  type: string,
  deliveries: number,
  setup: Setup,
  samples: number
) {
  const bindings = new EventBindings(() => {})
  const delivered = { count: 0 }
  setup(bindings, delivered)
  const event = events[type]!
  const once = async () => {
    const plan = bindings.prepare(event, path)
    if (!plan) return
    try {
      await dispatchPlan(plan, () => true)
    } finally {
      bindings.release(plan)
    }
  }
  for (let index = 0; index < 500; index += 1) await once()
  delivered.count = 0
  Bun.gc(true)
  const timings: number[] = []
  let total = 0
  for (let index = 0; index < samples; index += 1) {
    const start = nanoseconds()
    await once()
    const elapsed = nanoseconds() - start
    timings.push(elapsed)
    total += elapsed
  }
  if (delivered.count !== deliveries * samples)
    throw new Error(
      name + ': expected ' + deliveries * samples + ' deliveries, got ' + delivered.count
    )
  const sorted = timings.toSorted((left, right) => left - right)
  const us = (value: number) => Number((value / 1e3).toFixed(3))
  return {
    scenario: name,
    type,
    deliveries,
    samples,
    meanUs: us(total / samples),
    p50Us: us(percentile(sorted, 0.5)),
    p95Us: us(percentile(sorted, 0.95)),
  }
}

const samples = Number(process.argv[2] ?? 5000)
const results = []
for (const [name, type, deliveries, setup] of scenarios)
  results.push(await measure(name, type, deliveries, setup, samples))
console.log(
  JSON.stringify(
    {
      bun: Bun.revision,
      platform: process.platform,
      arch: process.arch,
      depth,
      results,
    },
    null,
    2
  )
)
