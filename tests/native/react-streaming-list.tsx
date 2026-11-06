/** @jsxImportSource @bun-native/react */
import { render } from '@bun-native/react'
import { memo, useEffect, useState } from 'react'
import { runStreamingList } from './renderer-streaming-list.ts'
import {
  bodyStyle,
  frameStyle,
  headerStyle,
  listStyle,
  mainStyle,
  metaStyle,
  rowStyle,
  sidebarLines,
  sidebarStyle,
  sidebarTextStyle,
  type DensityName,
  type ListRow,
  type ListView,
  type ThemeName,
} from './streaming-list-model.ts'

interface RowProps {
  row: ListRow
  theme: ThemeName
  density: DensityName
  select: (id: number) => void
}
const sameRow = (a: RowProps, b: RowProps) =>
  a.theme === b.theme &&
  a.density === b.density &&
  a.select === b.select &&
  a.row.id === b.row.id &&
  a.row.meta === b.row.meta &&
  a.row.text === b.row.text &&
  a.row.selected === b.row.selected &&
  a.row.streaming === b.row.streaming

// Rows are keyed by message id and memoized by content, so a streamed token
// re-renders one row and only window shifts mount or unmount rows.
const Row = memo(function Row({ row, theme, density, select }: RowProps) {
  const tokens = { theme, density }
  return (
    <box style={rowStyle(tokens, row)} onPointerDown={() => select(row.id)}>
      <text text={row.meta} style={metaStyle(tokens, row)} />
      <text text={row.text} style={bodyStyle(tokens)} />
    </box>
  )
}, sameRow)

await runStreamingList('React', (window, initial, select) => {
  let current = initial
  let update!: (view: ListView) => void
  let disposed = false
  function App() {
    const [view, setView] = useState(initial)
    current = view
    update = setView
    useEffect(
      () => () => {
        disposed = true
        update = () => {
          throw new Error('Streaming-list update after React disposal')
        }
      },
      []
    )
    const [theme, density, selected] = sidebarLines(view)
    return (
      <box style={frameStyle(view)}>
        <box style={sidebarStyle(view)}>
          <text text={theme} style={sidebarTextStyle(view)} />
          <text text={density} style={sidebarTextStyle(view)} />
          <text text={selected} style={sidebarTextStyle(view, true)} />
        </box>
        <box style={mainStyle()}>
          <text text={view.status} style={headerStyle(view)} />
          <box style={listStyle(view)}>
            {view.rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                theme={view.theme}
                density={view.density}
                select={select}
              />
            ))}
          </box>
        </box>
      </box>
    )
  }
  return {
    root: render(<App />, window, { style: { width: 'fill', height: 'fill' } }),
    rendered: () => current,
    publish: (view) => update(view),
    disposed: () => disposed,
  }
})
