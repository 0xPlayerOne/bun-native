/** @jsxImportSource @bun-native/react */
import type { InputState } from '@bun-native/core'
import { inputState, render, type NativeRef } from '@bun-native/react'
import assert from 'node:assert/strict'
import { createRef, useEffect, useState } from 'react'
import { runRendererInteractions } from './renderer-interactions.ts'

await runRendererInteractions('React', (window, handlers) => {
  const input = createRef<NativeRef>()
  let currentValue: InputState = { value: 'ABCD', revision: 0 }
  let replaceInput!: (state: InputState) => void
  let replaceCount!: (count: number) => void
  let disposed = false
  function App() {
    const [count, setCount] = useState(0)
    const [value, setValue] = useState<InputState>({ value: 'ABCD', revision: 0 })
    currentValue = value
    replaceInput = setValue
    replaceCount = setCount
    useEffect(
      () => () => {
        disposed = true
        replaceInput = () => {
          throw new Error('Input state update after React owner disposal')
        }
        replaceCount = () => {
          throw new Error('Counter state update after React owner disposal')
        }
      },
      []
    )
    return (
      <box {...handlers('frame')} style={{ direction: 'column', padding: 24, gap: 12 }}>
        <text text="React native event properties" style={{ height: 32, font_size: 24 }} />
        <text text={`Clicks: ${count}`} style={{ height: 28 }} />
        <button {...handlers('button')} text="Native action" style={{ width: 200, height: 44 }} />
        <input
          {...handlers('input')}
          ref={input}
          value={value}
          style={{ width: 'fill', height: 40, font_size: 20 }}
        />
        <text text={`Input: ${value.value}`} style={{ height: 28 }} />
      </box>
    )
  }
  return {
    root: render(<App />, window),
    input() {
      assert(input.current, 'The React input ref must remain mounted during qualification')
      return inputState(input.current)
    },
    value: () => currentValue,
    setInput: (value) => replaceInput(value),
    setCount: (count) => replaceCount(count),
    disposed() {
      if (disposed) assert.equal(input.current, null, 'OS close revokes the React native ref')
      return disposed
    },
  }
})
