import type { ClickEvent } from '@bun-native/core'
import { render, type JSX } from '@bun-native/solid'
import { createSignal, onCleanup } from 'solid-js'
import { runServiceAdapter } from './services-adapter.ts'

await runServiceAdapter('solid', (window, readDisplay, ownerDisposed) => {
  let setLabel: (text: string) => void = () => {
    throw new Error('Solid service fixture is not mounted')
  }
  // Keep the native listener identity stable while publishing the ready label.
  const clicked = async (event: ClickEvent) => {
    setLabel(await readDisplay(event))
    await view.flush()
  }
  function App(): JSX.Element {
    const [label, updateLabel] = createSignal('Preparing display')
    setLabel = updateLabel
    onCleanup(ownerDisposed)
    return (
      <box style={{ direction: 'column', gap: 12, padding: 24 }}>
        <text text="Bun Native services" style={{ font_size: 28 }} />
        <text text={label()} />
        <button text="Read display" style={{ width: 160, height: 44 }} onClick={clicked} />
      </box>
    )
  }
  const view = render(App, window)
  return { view, markReady: () => setLabel('Display ready') }
})
