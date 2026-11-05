import { registerDropTarget, render, Show, type JSX, type SolidNode } from '@bun-native/solid'
import { createSignal, onCleanup } from 'solid-js'
import { runDropAdapter } from './drop-adapter.ts'

await runDropAdapter('solid', (window, ownerDisposed) => {
  let zone: SolidNode | undefined
  let setVisible: (visible: boolean) => void = () => {
    throw new Error('Solid drop fixture is not mounted')
  }
  function App(): JSX.Element {
    const [visible, update] = createSignal(true)
    setVisible = (value) => update(value)
    onCleanup(ownerDisposed)
    return (
      <box style={{ direction: 'row' }}>
        <Show when={visible()}>
          <box
            ref={(node) => {
              zone = node
              onCleanup(() => (zone = undefined))
            }}
            style={{ width: 260, height: 340 }}
          />
        </Show>
      </box>
    )
  }
  return {
    view: render(App, window),
    register(listener) {
      if (!zone) throw new Error('Solid drop zone is unmounted')
      return registerDropTarget(zone, listener)
    },
    mounted: () => zone !== undefined,
    show: (visible) => setVisible(visible),
  }
})
