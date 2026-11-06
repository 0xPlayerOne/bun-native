/** @jsxImportSource @bun-native/react */
import { registerDropTarget, render, type JSX, type NativeRef } from '@bun-native/react'
import { useEffect, useState } from 'react'
import { runDropAdapter } from './drop-adapter.ts'

await runDropAdapter('react', (window, ownerDisposed) => {
  let zone: NativeRef | null = null
  const reference = (node: NativeRef | null) => {
    zone = node
  }
  let setVisible: (visible: boolean) => void = () => {
    throw new Error('React drop fixture is not mounted')
  }
  function App(): JSX.Element {
    const [visible, update] = useState(true)
    setVisible = update
    useEffect(() => ownerDisposed, [])
    return (
      <box style={{ direction: 'row' }}>
        {visible ? <box ref={reference} style={{ width: 260, height: 340 }} /> : null}
      </box>
    )
  }
  return {
    view: render(<App />, window),
    register(listener) {
      if (!zone) throw new Error('React drop zone is unmounted')
      return registerDropTarget(zone, listener)
    },
    mounted: () => zone !== null,
    show: (visible) => setVisible(visible),
  }
})
