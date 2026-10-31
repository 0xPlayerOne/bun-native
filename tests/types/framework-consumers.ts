// Compile-only BN1 import/lifecycle contract. These are not renderer acceptance
// tests: the native Solid and React adapters are qualified separately.
import type { NativeNode, NativeWindow } from '@bun-native/core'
import { useEffect, useState, type ReactNode } from 'react'
import { createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

interface SharedInput {
  window: NativeWindow
  input: NativeNode<'input'>
}

/** Invoked inside a Solid owner by the future native renderer. No DOM imports. */
export function solidCoreConsumer(props: SharedInput): Accessor<string> {
  const [value, setValue] = createSignal(props.window.input(props.input).value)
  const unsubscribe = props.window.onInput(props.input, (event) => {
    setValue(event.value)
  })
  onCleanup(unsubscribe)
  return createMemo(() => `Observed: ${value()}`)
}

/** Invoked by a React renderer. It observes the same opaque native input. */
export function ReactCoreConsumer(props: SharedInput): ReactNode {
  const [value, setValue] = useState(() => props.window.input(props.input).value)
  useEffect(
    () => props.window.onInput(props.input, (event) => setValue(event.value)),
    [props.window, props.input]
  )
  return `Observed: ${value}`
}
