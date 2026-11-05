/** @jsxImportSource @bun-native/react */
import { inputState, render, type NativeRef } from '@bun-native/react'
import assert from 'node:assert/strict'
import { createRef, useEffect, useState } from 'react'
import {
  frameStyle,
  initialState,
  inputStyle,
  runInputViewport,
  statusText,
  type ViewportState,
} from './renderer-input-viewport.ts'

await runInputViewport('React', (window, handlers) => {
  const input = createRef<NativeRef>()
  let current = initialState()
  let update!: (state: ViewportState) => void
  let disposed = false
  function App() {
    const [state, setState] = useState(initialState)
    current = state
    update = setState
    useEffect(
      () => () => {
        disposed = true
        update = () => {
          throw new Error('Viewport state update after React disposal')
        }
      },
      []
    )
    return (
      <box style={frameStyle}>
        <text
          text="React native input viewport"
          style={{ height: 32, font_size: 24, color: 0xffffff }}
        />
        <text text={statusText(state)} style={{ height: 24, color: 0xffffff }} />
        <box style={{ direction: 'row', width: 'fill', height: 56, gap: 16 }}>
          <input {...handlers} ref={input} value={state.input} style={inputStyle(state.restyled)} />
          <box style={{ width: 320, height: 56, flex_shrink: 0 }} />
        </box>
        <text
          text="Owned native input geometry and pixel control"
          style={{ height: 24, color: 0xffffff }}
        />
      </box>
    )
  }
  return {
    root: render(<App />, window, { style: { width: 'fill', height: 'fill' } }),
    input() {
      assert(input.current)
      return inputState(input.current)
    },
    state: () => current,
    setState: (state) => update(state),
    disposed() {
      if (disposed) assert.equal(input.current, null)
      return disposed
    },
  }
})
