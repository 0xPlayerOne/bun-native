import { For, render } from '@bun-native/solid'
import { createMemo, createSignal, onCleanup } from 'solid-js'
import { runStreamingList } from './renderer-streaming-list.ts'
import {
  bodyStyle,
  frameStyle,
  headerStyle,
  listAccessibility,
  listStyle,
  mainStyle,
  metaStyle,
  rowAccessibility,
  rowStyle,
  sidebarLines,
  sidebarStyle,
  sidebarTextStyle,
  type ListRow,
  type ListView,
} from './streaming-list-model.ts'

await runStreamingList('Solid', (window, initial, select) => {
  let read!: () => ListView
  let update!: (view: ListView) => void
  let disposed = false
  function App() {
    const [view, setView] = createSignal(initial)
    read = view
    update = setView
    onCleanup(() => {
      disposed = true
      update = () => {
        throw new Error('Streaming-list update after Solid disposal')
      }
    })
    // Rows are keyed by primitive message id: a token or restyle updates the
    // existing native row, and only window shifts create or remove rows.
    const ids = createMemo(() => view().rows.map((row) => row.id))
    const rows = createMemo(() => new Map(view().rows.map((row) => [row.id, row])))
    const lines = createMemo(() => sidebarLines(view()))
    return (
      <box style={frameStyle(view())}>
        <box style={sidebarStyle(view())}>
          <text text={lines()[0]} style={sidebarTextStyle(view())} />
          <text text={lines()[1]} style={sidebarTextStyle(view())} />
          <text text={lines()[2]} style={sidebarTextStyle(view(), true)} />
        </box>
        <box style={mainStyle()}>
          <text text={view().status} style={headerStyle(view())} />
          <box {...listAccessibility(view())} style={listStyle(view())}>
            <For each={ids()}>
              {(id) => {
                // A removed id is unmounted before this accessor can be read again.
                const row = () => rows().get(id) as ListRow
                return (
                  <box
                    {...rowAccessibility(row())}
                    style={rowStyle(view(), row())}
                    onPointerDown={() => select(id)}
                  >
                    <text text={row().meta} style={metaStyle(view(), row())} />
                    <text text={row().text} style={bodyStyle(view())} />
                  </box>
                )
              }}
            </For>
          </box>
        </box>
      </box>
    )
  }
  return {
    root: render(App, window, { style: { width: 'fill', height: 'fill' } }),
    rendered: () => read(),
    publish: (view) => update(view),
    disposed: () => disposed,
  }
})
