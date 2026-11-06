import type { InputState } from '@bun-native/core'
import type { JSX, RenderRoot } from '@bun-native/solid'
import { batch, createEffect, createSignal, For, onCleanup } from 'solid-js'
import { recordEvidence } from '../native-window/content.ts'

const items = [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }]

/** Lifetime counters the launcher checks after the window closes. */
export interface CounterStats {
  rowsCreated: number
  rowsDisposed: number
  effects: number
  ownerDisposed: boolean
}

export function createCounterStats(): CounterStats {
  return { rowsCreated: 0, rowsDisposed: 0, effects: 0, ownerDisposed: false }
}

export function App(props: { stats: CounterStats; view: () => RenderRoot }): JSX.Element {
  const { stats, view } = props
  const [clicks, setClicks] = createSignal(0)
  const [rows, setRows] = createSignal(items)
  const [input, setInput] = createSignal<InputState>({ value: '', revision: 0 })
  createEffect(() => {
    stats.effects += 1
    recordEvidence({ type: 'solid-effect', clicks: clicks(), effects: stats.effects })
  })
  onCleanup(() => {
    stats.ownerDisposed = true
  })
  return (
    <box style={{ direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 }}>
      <text style={{ font_size: 28 }}>Bun Native Solid</text>
      <text text={`Clicks: ${clicks()}`} />
      <button
        text="Increment"
        style={{ width: 160, height: 44 }}
        onClick={async (event) => {
          const before = view().diagnostics
          batch(() => {
            setClicks((value) => value + 1)
            setRows(clicks() % 2 ? [items[2]!, items[0]!] : items)
          })
          await view().flush()
          const after = view().diagnostics.mutations
          if (
            clicks() === 1 &&
            (stats.rowsCreated !== 3 ||
              stats.rowsDisposed !== 1 ||
              after.create !== before.mutations.create ||
              after.set - before.mutations.set !== 1 ||
              after.insert - before.mutations.insert !== 1 ||
              after.remove - before.mutations.remove !== 1)
          )
            throw new Error('Solid keyed update recreated nodes or emitted unexpected mutations')
          recordEvidence({ type: 'click', sequence: event.sequence, target: 'increment' })
          recordEvidence({
            type: 'solid-keyed-update',
            names: rows().map((row) => row.name),
            rowsCreated: stats.rowsCreated,
            rowsDisposed: stats.rowsDisposed,
            mutationsBefore: before.mutations,
            mutationsAfter: view().diagnostics.mutations,
          })
        }}
      />
      <text text="Native editable input" />
      <input
        value={input()}
        placeholder="Type here…"
        style={{ width: 'fill', font_size: 24 }}
        onInput={(event) => {
          // Passing the actual event observes its revision; an older echo never
          // becomes an application replacement of a newer native edit.
          setInput(event)
          recordEvidence({
            type: 'input',
            sequence: event.sequence,
            value: event.value,
            input_revision: event.revision,
          })
        }}
      />
      <text text={`Input: ${input().value}`} />
      <box style={{ direction: 'row', gap: 16 }}>
        <For each={rows()}>
          {(row) => {
            stats.rowsCreated += 1
            onCleanup(() => stats.rowsDisposed++)
            return <text text={row.name} />
          }}
        </For>
      </box>
    </box>
  )
}
