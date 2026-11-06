/** @jsxImportSource @bun-native/react */
// Compile-only contract for the React adapter's render, inputState and JSX runtime entry points.
import type { InputState, NativeNode, NativeWindow } from '@bun-native/core'
import {
  inputState,
  render,
  type JSX,
  type NativeRef,
  type ReactRenderOptions,
  type ReactRenderRoot,
} from '@bun-native/react'
import { jsxDEV, type JSX as DevJSX } from '@bun-native/react/jsx-dev-runtime'
import { Fragment, jsx, jsxs, type JSX as RuntimeJSX } from '@bun-native/react/jsx-runtime'
import { createRef } from 'react'

function Toolbar(props: { readonly label: string }): JSX.Element {
  return (
    <>
      <text>{props.label}</text>
      <button disabled>Run</button>
    </>
  )
}

export async function checkRender(window: NativeWindow): Promise<InputState | undefined> {
  const editor = createRef<NativeRef>()
  const options: ReactRenderOptions = { style: { width: 'fill' } }
  const root: ReactRenderRoot = render(
    <box>
      <Toolbar label="Typed" />
      <input ref={editor} placeholder="Name" />
    </box>,
    window,
    options
  )
  await root.ready
  await root.render(<Toolbar label="Replaced" />)
  await root.render(null)
  await root.flush()
  const commits: number = root.diagnostics.commits
  const state = editor.current ? inputState(editor.current) : undefined
  await root.dispose()
  await root.closed
  void commits

  // @ts-expect-error A component needs its declared props.
  render(<Toolbar />, window)
  // @ts-expect-error A component prop keeps its declared type.
  render(<Toolbar label={1} />, window)
  // @ts-expect-error React mounts into a native window, not a DOM container.
  render(<box />, { appendChild() {} })
  // @ts-expect-error React render options have no DOM root identifier.
  render(<box />, window, { identifierPrefix: 'app' })
  // @ts-expect-error React roots are replaced with render, not DOM-style unmount.
  root.unmount()
  // @ts-expect-error The root's ready promise is read-only.
  root.ready = Promise.resolve()
  return state
}

export function checkInputState(handle: NativeNode<'input'>, ref: NativeRef): InputState {
  const state = inputState(ref)
  // @ts-expect-error Observed input state cannot be edited in place.
  state.value = 'edited'
  // @ts-expect-error React refs are renderer nodes, not core native handles.
  inputState(handle)
  return state
}

export function checkRuntimeEntryPoints(): readonly RuntimeJSX.Element[] {
  // The re-exported React runtime functions are typed by React (props are not checked there),
  // so JSX syntax, checked against the native namespace below, is the typed path.
  const single: RuntimeJSX.Element = jsx(Toolbar, { label: 'Single' })
  const many: RuntimeJSX.Element = jsxs(Fragment, {
    children: [jsx(Toolbar, { label: 'First' }), jsx(Toolbar, { label: 'Second' })],
  })
  const fragment: RuntimeJSX.Element = jsx(Fragment, { children: single })
  const dev: DevJSX.Element = jsxDEV(
    Toolbar,
    { label: 'Dev' },
    undefined,
    false,
    undefined,
    undefined
  )
  const shared: JSX.Element = dev
  // @ts-expect-error The runtime JSX namespace has no DOM intrinsic elements.
  const div: RuntimeJSX.IntrinsicElements['div'] = {}
  // @ts-expect-error The dev runtime shares the same native intrinsic element table.
  const span: DevJSX.IntrinsicElements['span'] = {}
  // @ts-expect-error Native buttons are not disabled with strings.
  const button: RuntimeJSX.IntrinsicElements['button'] = { disabled: 'disabled' }
  void [div, span, button]
  return [single, many, fragment, shared]
}
