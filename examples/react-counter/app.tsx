/** @jsxImportSource @bun-native/react */
import type { InputState } from '@bun-native/core'
import type { JSX, ReactRenderRoot } from '@bun-native/react'
import { useEffect, useState } from 'react'
import { recordEvidence } from '../native-window/content.ts'

const items = ['Alpha', 'Beta', 'Gamma']

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

function Row({ name, stats }: { name: string; stats: CounterStats }): JSX.Element {
  useEffect(() => {
    stats.rowsCreated += 1
    return () => {
      stats.rowsDisposed += 1
    }
  }, [])
  return <text>{name}</text>
}

export function App({
  stats,
  view,
}: {
  stats: CounterStats
  view: () => ReactRenderRoot
}): JSX.Element {
  const [clicks, setClicks] = useState(0)
  const [rows, setRows] = useState(items)
  const [input, setInput] = useState<InputState>({ value: '', revision: 0 })
  useEffect(() => {
    stats.effects += 1
    recordEvidence({ type: 'react-effect', clicks, effects: stats.effects })
  }, [clicks])
  useEffect(
    () => () => {
      stats.ownerDisposed = true
    },
    []
  )
  return (
    <box style={{ direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 }}>
      <text style={{ font_size: 28 }}>Bun Native React</text>
      <text>Clicks: {clicks}</text>
      <button
        style={{ width: 160, height: 44 }}
        onClick={async (event) => {
          const before = view().diagnostics
          const next = clicks + 1
          setClicks(next)
          setRows(next % 2 ? [items[2]!, items[0]!] : items)
          await view().flush()
          const after = view().diagnostics.mutations
          if (
            next === 1 &&
            (stats.rowsCreated !== 3 ||
              stats.rowsDisposed !== 1 ||
              after.create !== before.mutations.create ||
              after.set - before.mutations.set !== 1 ||
              after.insert - before.mutations.insert !== 1 ||
              after.remove - before.mutations.remove !== 1)
          )
            throw new Error(
              'React keyed update recreated native nodes or emitted unexpected mutations'
            )
          if (event.signal.aborted)
            throw new Error('React rerender revoked its active native callback')
          recordEvidence({ type: 'click', sequence: event.sequence, target: 'increment' })
          recordEvidence({
            type: 'react-keyed-update',
            rowsCreated: stats.rowsCreated,
            rowsDisposed: stats.rowsDisposed,
            mutationsBefore: before.mutations,
            mutationsAfter: after,
          })
        }}
      >
        Increment
      </button>
      <text>Native editable input</text>
      <input
        value={input}
        placeholder="Type here…"
        style={{ width: 'fill', font_size: 24 }}
        onInput={(event) => {
          setInput(event)
          recordEvidence({
            type: 'input',
            sequence: event.sequence,
            value: event.value,
            input_revision: event.revision,
          })
        }}
      />
      <text>Input: {input.value}</text>
      <box style={{ direction: 'row', gap: 16 }}>
        {rows.map((name) => (
          <Row key={name} name={name} stats={stats} />
        ))}
      </box>
    </box>
  )
}
