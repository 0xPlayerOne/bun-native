import { inputState, render, type JSX, type SolidNode } from '@bun-native/solid'
import { createSignal, onCleanup } from 'solid-js'
import { INITIAL_ELEMENTS, ROOT_ELEMENT } from '../../examples/native-window/content.ts'
import {
  initialPlatformState,
  runPlatformAdapter,
  type PlatformAdapterState,
} from './platform-adapter.ts'

await runPlatformAdapter('solid', (window, handlers, ownerDisposed) => {
  let input: SolidNode | undefined
  let update: (state: PlatformAdapterState) => void = () => {
    throw new Error('Solid platform fixture is not mounted')
  }
  function App(): JSX.Element {
    const [state, setState] = createSignal(initialPlatformState)
    update = (value) => setState(value)
    onCleanup(ownerDisposed)
    return (
      <box
        style={ROOT_ELEMENT.style}
        onPointerDownCapture={handlers.onPointerDownCapture}
        onPointerUpCapture={handlers.onPointerUpCapture}
        onKeyDownCapture={handlers.onKeyDownCapture}
        onKeyUpCapture={handlers.onKeyUpCapture}
        onFocusCapture={handlers.onFocusCapture}
        onBlurCapture={handlers.onBlurCapture}
      >
        <text text="Bun Native" style={INITIAL_ELEMENTS[0].style} />
        <text text={state().label} />
        <button text="Increment" style={INITIAL_ELEMENTS[2].style} onClick={handlers.onClick} />
        <text text="Native editable input" />
        <input
          ref={(node) => {
            input = node
          }}
          value={state().input}
          placeholder={INITIAL_ELEMENTS[4].placeholder}
          style={INITIAL_ELEMENTS[4].style}
          onInput={handlers.onInput}
        />
      </box>
    )
  }
  return {
    view: render(App, window),
    input() {
      if (!input) throw new Error('Solid input reference is unavailable')
      return inputState(input)
    },
    update: (state) => update(state),
  }
})
