/** @jsxImportSource @bun-native/react */
/**
 * Headless React mail-workspace adapter micro benchmark.
 *
 * Mounts a realistic styled tree through `@bun-native/react` against an
 * in-process NativeWindow that counts native operations and acknowledges
 * immediately: a folder sidebar, a search toolbar, `rows` message rows
 * (box > [box > [text, text], text, button]) and a detail pane holding a
 * long log text. `sync` is React's render and commit including every host
 * config callback; `total` adds the commit barrier and the renderer's
 * snapshot/diff/publish. Neither is IPC, core validation, native or paint.
 *
 *   NODE_ENV=production bun benchmarks/adapters/react-workspace.tsx [rows] [samples]
 */
import type { NativeWindow } from '@bun-native/core'
import { render } from '@bun-native/react'
import { fakeWindow, median, now, type Operations, themes, type Workspace } from './workspace.ts'

const noop = () => {}

function App({ state }: { state: Workspace }) {
  const theme = themes[state.theme]!
  const query = state.query
  const rows = query
    ? state.messages.filter((message) => message.subject.includes(query))
    : state.messages
  return (
    <box
      style={{
        direction: 'row',
        background: theme.background,
        width: 'fill',
        height: 'fill',
      }}
    >
      <box style={{ direction: 'column', gap: 2, padding: 8, width: 180 }}>
        {state.folders.map((folder) => (
          <box key={folder.id} style={{ direction: 'row', gap: 4, padding: 4 }}>
            <text style={{ color: theme.text, flex_grow: 1 }}>{folder.name}</text>
            <text style={{ color: theme.muted }}>{String(folder.unread)}</text>
          </box>
        ))}
      </box>
      <box style={{ direction: 'column', flex_grow: 1 }}>
        <box style={{ direction: 'row', gap: 4, padding: 4 }}>
          <input value="" placeholder="Search" style={{ flex_grow: 1 }} />
          <button text="Compose" onClick={noop} />
        </box>
        <box style={{ direction: 'column', overflow: 'scroll_y', flex_grow: 1 }}>
          {rows.map((message) => {
            const selected = message.id === state.selected
            return (
              <box
                key={message.id}
                style={{
                  direction: 'row',
                  gap: 8,
                  padding: 4,
                  background: selected ? theme.selection : theme.background,
                }}
                onClick={noop}
              >
                <box style={{ direction: 'column', flex_grow: 1 }}>
                  <text style={{ color: theme.text, font_size: 14 }}>{message.subject}</text>
                  <text style={{ color: theme.muted, font_size: 12 }}>{message.preview}</text>
                </box>
                <text style={{ color: theme.muted }}>{message.date}</text>
                <button text={message.starred ? 'Unstar' : 'Star'} onClick={noop} />
              </box>
            )
          })}
        </box>
      </box>
      <box style={{ direction: 'column', padding: 8, width: 360 }}>
        <text style={{ color: theme.text }}>{state.log}</text>
      </box>
    </box>
  )
}

async function scenario(count: number, samples: number) {
  const { window, operations, state, update } = fakeWindow(count)
  let view!: ReturnType<typeof render>
  const mount: number[] = []
  // Fresh mounts: the whole tree in one commit.
  for (let sample = 0; sample < 12; sample += 1) {
    const start = now()
    view = render(<App state={state()} />, window as NativeWindow)
    await view.ready
    if (sample >= 2) mount.push(now() - start)
    if (sample < 11) await view.dispose()
  }
  const commit = async (change: () => void) => {
    const start = now()
    change()
    const pending = view.render(<App state={state()} />)
    const submitted = now()
    await pending
    return { sync: submitted - start, total: now() - start }
  }
  const results: Record<string, { sync: number; total: number; operations: Operations }> = {}
  for (const [name, change] of Object.entries(update)) {
    const sync: number[] = []
    const total: number[] = []
    let before = { ...operations }
    for (let sample = 0; sample < samples + 10; sample += 1) {
      if (sample === 10) before = { ...operations }
      const result = await commit(change)
      if (sample < 10) continue
      sync.push(result.sync)
      total.push(result.total)
    }
    const per = Object.fromEntries(
      Object.entries(operations).map(([key, value]) => [
        key,
        (value - before[key as keyof Operations]) / samples,
      ])
    ) as Operations
    results[name] = {
      sync: median(sync),
      total: median(total),
      operations: per,
    }
  }
  await view.dispose()
  return { mount: median(mount), results }
}

const rows = Number(process.argv[2] ?? 1000)
const samples = Number(process.argv[3] ?? 100)
const { mount, results } = await scenario(rows, samples)
console.log(`react rows=${rows} samples=${samples} median µs (ops per commit)`)
console.log(`mount    total ${mount.toFixed(1).padStart(9)}`)
for (const [name, { sync, total, operations }] of Object.entries(results))
  console.log(
    `${name.padEnd(8)} sync ${sync.toFixed(1).padStart(8)}  total ${total.toFixed(1).padStart(9)}  ${JSON.stringify(operations)}`
  )
