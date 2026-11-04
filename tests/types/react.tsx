/** @jsxImportSource @bun-native/react */
import type { NativeNode } from '@bun-native/core'
import type { JSX, NativeRef, ReactRenderOptions } from '@bun-native/react'
import { createRef } from 'react'

export function nativeReactContract(): JSX.Element {
  const reference = createRef<NativeRef>()
  const accepted = (
    <box
      key="workspace"
      style={{ gap: 12, overflow: 'scroll_y', align_items: 'stretch', min_height: 80 }}
      onInputCapture={(event) => {
        event.value.toUpperCase()
        event.stopPropagation()
      }}
      onKeyDownCapture={(event) => {
        event.key.toUpperCase()
        event.keyChar?.toLowerCase()
        event.modifiers.shift.valueOf()
        // @ts-expect-error Logical native keys do not establish a physical DOM code.
        void event.code
        // @ts-expect-error The current native event contract does not report repeat.
        void event.repeat
      }}
    >
      <text key={1} ref={reference}>
        Literal native text
      </text>
      <button
        key={2n}
        onClick={(event) => {
          event.signal.throwIfAborted()
          event.currentTarget.kind.toUpperCase()
          event.path.forEach((node) => node.kind)
        }}
        onPointerUpCapture={(event) => {
          event.x.toFixed()
          event.y.toFixed()
          event.button.toUpperCase()
          // @ts-expect-error Pointer notifications have no committed input value.
          void event.value
        }}
        onFocusCapture={(event) => {
          event.stopImmediatePropagation()
          // @ts-expect-error JavaScript propagation cannot prevent an OS default action.
          event.preventDefault()
        }}
      >
        Action
      </button>
      <input
        key="editor"
        value={{ value: '', revision: 0 }}
        onInput={(event) => {
          event.value.toUpperCase()
        }}
      />
    </box>
  )
  // @ts-expect-error Browser elements are not native intrinsic elements.
  const browser = <div />
  // @ts-expect-error React keys are strings, numbers, or bigints, never native handles.
  const invalidKey = <box key={reference} />
  // @ts-expect-error CSS strings are not typed native dimensions.
  const css = <box style={{ width: '100%' }} />
  // @ts-expect-error Native text input uses onInput, without DOM ChangeEvent.
  const change = <input onChange={() => {}} />
  // @ts-expect-error Inputs cannot own children.
  const children = <input>Text</input>
  // @ts-expect-error Scroll containers must be boxes, not native leaf controls.
  const leafScroll = <input style={{ overflow: 'scroll_y' }} />
  // @ts-expect-error Event handlers are callable, including capture handlers.
  const capture = <box onKeyUpCapture="callback" />
  // @ts-expect-error DOM pointer-move events are not in the supported native event table.
  const move = <box onPointerMove={() => {}} />
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
  const options: ReactRenderOptions = {
    style: { width: 'fill', height: 'fill', overflow: 'hidden' },
    onRecoverableError(error, info) {
      void error
      info.componentStack?.trim()
    },
  }
  // @ts-expect-error Recovery reporting is a callable contract.
  const invalidOptions: ReactRenderOptions = { onRecoverableError: true }
  // @ts-expect-error Root container dimensions use the shared native style contract.
  const invalidRootStyle: ReactRenderOptions = { style: { height: '100%' } }
  void [
    browser,
    invalidKey,
    css,
    change,
    children,
    leafScroll,
    capture,
    move,
    target,
    handle,
    options,
    invalidOptions,
    invalidRootStyle,
  ]
  return accepted
}
