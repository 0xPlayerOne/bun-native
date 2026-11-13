import { NativeStateError, type NativeWindow } from '@bun-native/core'
import { createRenderRoot, type RenderOptions, type RenderRoot } from '@bun-native/renderer'
import { catchError, createMemo, createRoot, createSignal } from 'solid-js'
import type { JSX } from './jsx.ts'
import { renderer } from './renderer.ts'

export type { RenderOptions, RenderRoot } from '@bun-native/renderer'

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
export function render(
  component: () => JSX.Element,
  window: NativeWindow,
  options: RenderOptions = {}
): RenderRoot {
  if (typeof component !== 'function')
    throw new NativeStateError('invalid_state', 'Solid render requires a component function')
  assertReactiveRuntime()
  return createRenderRoot(
    window,
    ({ container, onCleanup, fail }) => {
      createRoot((dispose) => {
        onCleanup(dispose)
        // An error from a later reactive update ends only this root, as in
        // React, instead of escaping through whichever setter (usually a
        // native listener) ran it and ending the application. An error while
        // evaluating the component still rejects `ready` synchronously.
        let mounted = false
        let initial: { cause: unknown } | undefined
        catchError(
          () => renderer.insert(container, component()),
          (cause) => {
            if (mounted) fail(cause)
            else initial ??= { cause }
          }
        )
        if (initial) throw initial.cause
        mounted = true
      })
    },
    options
  )
}
