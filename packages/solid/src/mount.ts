import { NativeStateError, type NativeWindow } from '@bun-native/core'
import { createRenderRoot, type RenderRoot } from '@bun-native/renderer'
import { createMemo, createRoot, createSignal } from 'solid-js'
import type { JSX } from './jsx.ts'
import { renderer } from './renderer.ts'

export type { RenderRoot } from '@bun-native/renderer'

function assertReactiveRuntime(): void {
  let observed = -1
  createRoot((dispose) => {
    const [value, set] = createSignal(0)
    const derived = createMemo(value)
    set(1)
    observed = derived()
    dispose()
  })
  if (observed !== 1)
    throw new Error(
      'Solid native rendering requires Bun --conditions=browser (reactive Solid exports)'
    )
}

/** Mount one Solid owner into an independently disposable native container. */
export function render(component: () => JSX.Element, window: NativeWindow): RenderRoot {
  if (typeof component !== 'function')
    throw new NativeStateError('invalid_state', 'Solid render requires a component function')
  assertReactiveRuntime()
  return createRenderRoot(window, ({ container, onCleanup }) => {
    createRoot((dispose) => {
      onCleanup(dispose)
      renderer.insert(container, component())
    })
  })
}
