/** @jsxImportSource @bun-native/react */
import type { NativeNode } from '@bun-native/core'
import type { JSX, NativeRef } from '@bun-native/react'
import { createRef } from 'react'

export function nativeReactContract(): JSX.Element {
  const reference = createRef<NativeRef>()
  const accepted = (
    <box style={{ gap: 12 }}>
      <text ref={reference}>Literal native text</text>
      <button
        onClick={(event) => {
          event.signal.throwIfAborted()
        }}
      >
        Action
      </button>
      <input
        value={{ value: '', revision: 0 }}
        onInput={(event) => {
          event.value.toUpperCase()
        }}
      />
    </box>
  )
  // @ts-expect-error Browser elements are not native intrinsic elements.
  const browser = <div />
  // @ts-expect-error CSS strings are not typed native dimensions.
  const css = <box style={{ width: '100%' }} />
  // @ts-expect-error Native text input uses onInput, without DOM ChangeEvent.
  const change = <input onChange={() => {}} />
  // @ts-expect-error Inputs cannot own children.
  const children = <input>Text</input>
  const target = (
    <button
      onClick={(event) => {
        // @ts-expect-error The native click event has no DOM target.
        void event.target.value
      }}
    />
  )
  // @ts-expect-error A renderer reference does not expose a core native handle.
  const handle: NativeNode | null = reference.current
  void [browser, css, change, children, target, handle]
  return accepted
}
