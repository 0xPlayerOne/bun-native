/** @jsxImportSource @bun-native/react */
/**
 * Headless React keyed-list adapter micro benchmark.
 *
 * Mounts keyed rows through `@bun-native/react` against an in-process
 * NativeWindow whose batch acknowledges immediately. `sync` times React's
 * synchronous render and commit, including every host config callback (the
 * adapter hot path); `total` additionally awaits the commit barrier and the
 * renderer's snapshot/diff/publish. Neither is IPC, native or paint latency.
 *
 *   bun benchmarks/react/keyed.tsx [rows] [samples]
 */
import type { NativeBatch, NativeNode, NativeWindow } from '@bun-native/core'
import { render } from '@bun-native/react'

function fakeWindow(): NativeWindow {
  let id = 0
  const handle = (kind: string) => ({ kind, id: id++ }) as unknown as NativeNode
  const batch: NativeBatch = {
    create: (element) => handle(element.kind) as never,
    set: () => {},
    insert: () => {},
    append: () => {},
    remove: () => {},
  }
  return {
    root: handle('box'),
    closed: new Promise<void>(() => {}),
    revision: 0,
    batch: async (update: (batch: NativeBatch) => unknown) => update(batch),
    on: () => () => {},
    input: () => ({ value: '', revision: 0 }),
    close: async () => {},
  } as unknown as NativeWindow
}

const now = () => Number(process.hrtime.bigint()) / 1e3
const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!
const warmup = 20
const noop = () => {}

type Row = { id: number; label: string }

function List({ rows, gap }: { rows: readonly Row[]; gap: number }) {
  return (
    <box style={{ gap }}>
      {rows.map((row) => (
        <box key={row.id} style={{ padding: gap }}>
          <text onClick={noop}>{row.label}</text>
        </box>
      ))}
    </box>
  )
}

const row = (id: number): Row => ({ id, label: 'row ' + id })

async function scenario(count: number, samples: number) {
  let rows = Array.from({ length: count }, (_, index) => row(index))
  let next = count
  let gap = 0
  const view = render(<List rows={rows} gap={gap} />, fakeWindow())
  await view.ready
  const commit = async (update: () => void) => {
    const start = now()
    update()
    const pending = view.render(<List rows={rows} gap={gap} />)
    const submitted = now()
    await pending
    return { sync: submitted - start, total: now() - start }
  }
  // Each operation keeps the row count stable around `count`.
  const operations: Record<string, () => void> = {
    append: () => (rows = [...rows.slice(1), row(next++)]),
    swap: () => {
      const copy = rows.slice()
      const first = copy[1]!
      copy[1] = copy[copy.length - 2]!
      copy[copy.length - 2] = first
      rows = copy
    },
    remove: () => (rows = [...rows.filter((_, index) => index !== rows.length >> 1), row(next++)]),
    prepend: () => (rows = [row(next++), ...rows.slice(0, -1)]),
    // Every row rerenders with a new style object: exercises property diffing.
    restyle: () => (gap = (gap + 1) % 8),
  }
  const results: Record<string, { sync: number; total: number }> = {}
  for (const [name, operation] of Object.entries(operations)) {
    const sync: number[] = []
    const total: number[] = []
    for (let sample = 0; sample < samples + warmup; sample += 1) {
      const result = await commit(operation)
      if (sample < warmup) continue
      sync.push(result.sync)
      total.push(result.total)
    }
    results[name] = { sync: median(sync), total: median(total) }
  }
  // Replacing every keyed row deletes and mounts `count` rows in one commit.
  const replace: number[] = []
  const clear: number[] = []
  for (let sample = 0; sample < 10; sample += 1) {
    replace.push((await commit(() => (rows = rows.map(() => row(next++))))).sync)
    clear.push((await commit(() => (rows = []))).sync)
    await commit(() => (rows = Array.from({ length: count }, () => row(next++))))
  }
  await view.dispose()
  return { results, replace: median(replace), clear: median(clear) }
}

const rows = Number(process.argv[2] ?? 1000)
const samples = Number(process.argv[3] ?? 200)
const { results, replace, clear } = await scenario(rows, samples)
console.log(`rows=${rows} samples=${samples} median µs`)
for (const [name, { sync, total }] of Object.entries(results))
  console.log(
    `${name.padEnd(8)} sync ${sync.toFixed(1).padStart(8)}  total ${total.toFixed(1).padStart(9)}`
  )
console.log(`replace  sync ${replace.toFixed(1).padStart(8)}`)
console.log(`clear    sync ${clear.toFixed(1).padStart(8)}`)
