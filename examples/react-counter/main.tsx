/** @jsxImportSource @bun-native/react */
import { createApplication, type InputState } from '@bun-native/core'
import { render, type JSX, type ReactRenderRoot } from '@bun-native/react'
import { useEffect, useState } from 'react'
import { resolve } from 'node:path'
import { recordEvidence } from '../native-window/content.ts'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to an existing prebuilt native host')
const application = await createApplication({ executable: resolve(executable) })
const items = ['Alpha', 'Beta', 'Gamma']
let rowsCreated = 0
let rowsDisposed = 0
let effects = 0
let ownerDisposed = false
let view: ReactRenderRoot | undefined

function Row({ name }: { name: string }): JSX.Element {
  useEffect(() => {
    rowsCreated += 1
    return () => {
      rowsDisposed += 1
    }
  }, [])
  return <text>{name}</text>
}

function App(): JSX.Element {
  const [clicks, setClicks] = useState(0)
  const [rows, setRows] = useState(items)
  const [input, setInput] = useState<InputState>({ value: '', revision: 0 })
  useEffect(() => {
    effects += 1
    recordEvidence({ type: 'react-effect', clicks, effects })
  }, [clicks])
  useEffect(
    () => () => {
      ownerDisposed = true
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
          const before = view!.diagnostics
          const next = clicks + 1
          setClicks(next)
          setRows(next % 2 ? [items[2]!, items[0]!] : items)
          await view!.flush()
          const after = view!.diagnostics.mutations
          if (
            next === 1 &&
            (rowsCreated !== 3 ||
              rowsDisposed !== 1 ||
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
            rowsCreated,
            rowsDisposed,
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
          <Row key={name} name={name} />
        ))}
      </box>
    </box>
  )
}

try {
  const window = await application.openWindow({
    title: 'Bun Native React',
    width: 640,
    height: 520,
  })
  view = render(<App />, window)
  await view.ready
  recordEvidence({ type: 'react-mounted', diagnostics: view.diagnostics, rowsCreated, effects })
  await window.closed
  await view.dispose()
  recordEvidence({
    type: 'react-disposed',
    diagnostics: view.diagnostics,
    rowsCreated,
    rowsDisposed,
    ownerDisposed,
  })
  if (!ownerDisposed || rowsCreated !== rowsDisposed || view.diagnostics.nodes !== 0)
    throw new Error('React owner or keyed rows survived window close')
  recordEvidence({ type: 'closed' })
} finally {
  await view?.dispose()
  await application.shutdown()
  await application.closed
}
