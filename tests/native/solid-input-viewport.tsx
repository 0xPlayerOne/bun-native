import { inputState, render, type SolidNode } from '@bun-native/solid'
import assert from 'node:assert/strict'
import { createSignal, onCleanup } from 'solid-js'
import {
  frameStyle,
  initialState,
  inputStyle,
  runInputViewport,
  statusText,
  type ViewportState,
} from './renderer-input-viewport.ts'

await runInputViewport('Solid', (window, handlers) => {
  let input: SolidNode | undefined
  let read!: () => ViewportState
  let update!: (state: ViewportState) => void
  let disposed = false
  function App() {
    const [state, setState] = createSignal(initialState())
    read = state
    update = setState
    onCleanup(() => {
      disposed = true
      input = undefined
      update = () => {
        throw new Error('Viewport state update after Solid disposal')
      }
    })
    return (
      <box style={frameStyle}>
        <text
          text="Solid native input viewport"
          style={{ height: 32, font_size: 24, color: 0xffffff }}
        />
        <text text={statusText(state())} style={{ height: 24, color: 0xffffff }} />
        <box style={{ direction: 'row', width: 'fill', height: 56, gap: 16 }}>
          <input
            {...handlers}
            ref={(node) => {
              input = node
            }}
            value={state().input}
            style={inputStyle(state().restyled)}
          />
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
    root: render(App, window, { style: { width: 'fill', height: 'fill' } }),
    input() {
      assert(input)
      return inputState(input)
    },
    state: () => read(),
    setState: (state) => update(state),
    disposed() {
      if (disposed) assert.equal(input, undefined)
      return disposed
    },
  }
})
