/** @jsxImportSource @bun-native/react */
import type { ClickEvent } from '@bun-native/core'
import { render, type JSX } from '@bun-native/react'
import { useEffect, useState } from 'react'
import { runServiceAdapter } from './services-adapter.ts'

await runServiceAdapter('react', (window, readDisplay, ownerDisposed) => {
  let setLabel: (text: string) => void = () => {
    throw new Error('React service fixture is not mounted')
  }
  // A label-only rerender must not replace the click registration under test.
  const clicked = async (event: ClickEvent) => {
    setLabel(await readDisplay(event))
    await view.flush()
  }
  function App(): JSX.Element {
    const [label, updateLabel] = useState('Preparing display')
    setLabel = updateLabel
    useEffect(() => ownerDisposed, [])
    return (
      <box style={{ direction: 'column', gap: 12, padding: 24 }}>
        <text text="Bun Native services" style={{ font_size: 28 }} />
        <text text={label} />
        <button text="Read display" style={{ width: 160, height: 44 }} onClick={clicked} />
      </box>
    )
  }
  const view = render(<App />, window)
  return { view, markReady: () => setLabel('Display ready') }
})
