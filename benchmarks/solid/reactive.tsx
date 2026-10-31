import { batch, createSignal, onCleanup } from 'solid-js'
import { For, render, type SolidNode } from '@bun-native/solid'
import { CONTENT_STYLE, LIST_STYLE, ROW_STYLE, runWorkload } from './workload.ts'

await runWorkload('solid', async (window, initial) => {
  const [text, setText] = createSignal('Initial')
  const [rows, setRows] = createSignal(initial)
  let rowsCreated = 0
  let rowsDisposed = 0
  let unexpectedClicks = 0
  const listener = () => {
    unexpectedClicks++
  }
  let content!: SolidNode
  const view = render(
    () => (
      <box
        ref={(node) => {
          content = node
        }}
        style={CONTENT_STYLE}
      >
        <text text={text()} />
        <button text="Benchmark fixture" onClick={listener} />
        <box style={LIST_STYLE}>
          <For each={rows()}>
            {(row) => {
              rowsCreated++
              onCleanup(() => rowsDisposed++)
              return <text text={row.text} style={ROW_STYLE} />
            }}
          </For>
        </box>
      </box>
    ),
    window
  )
  await view.ready
  return {
    update(values) {
      batch(() => {
        for (const value of values) setText(value)
      })
      return view.flush()
    },
    rotate(next) {
      setRows(next)
      return view.flush()
    },
    dispose: () => view.dispose(),
    probes: [new WeakRef(view), new WeakRef(content), new WeakRef(listener)],
    inspect: () => ({
      mutations: { ...view.diagnostics.mutations },
      rowsCreated,
      rowsDisposed,
      unexpectedClicks,
    }),
  }
})
