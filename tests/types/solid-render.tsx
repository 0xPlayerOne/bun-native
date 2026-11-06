// Compile-only contract for the Solid adapter's render, inputState, control flow and compiler helpers.
import type { InputState, NativeNode, NativeWindow } from '@bun-native/core'
import {
  createComponent,
  createElement,
  createTextNode,
  ErrorBoundary,
  For,
  Index,
  inputState,
  insert,
  Match,
  render,
  setProp,
  Show,
  Switch,
  type JSX,
  type RenderOptions,
  type RenderRoot,
  type SolidNode,
} from '@bun-native/solid'
import type { JSX as RuntimeJSX } from '@bun-native/solid/jsx-runtime'

function Status(props: { readonly mode: 'idle' | 'busy' | 'failed'; readonly items: string[] }) {
  return (
    <box>
      <Switch fallback={<text text="Unknown" />}>
        <Match when={props.mode === 'idle'}>
          <text text="Idle" />
        </Match>
        <Match when={props.mode === 'busy'}>
          <text text="Busy" />
        </Match>
      </Switch>
      <Index each={props.items}>{(item, index) => <text text={`${index}: ${item()}`} />}</Index>
      <For each={props.items}>{(item) => <button text={item} />}</For>
      <Show when={props.items.length === 0} fallback={<text text="Items" />}>
        <text text="Empty" />
      </Show>
      <ErrorBoundary fallback={(error: unknown) => <text text={String(error)} />}>
        <input placeholder="Recoverable" />
      </ErrorBoundary>
    </box>
  )
}

export async function checkRender(window: NativeWindow): Promise<InputState | undefined> {
  let editor: SolidNode | undefined
  const options: RenderOptions = { style: { height: 'fill', direction: 'row' } }
  const root: RenderRoot = render(
    () => (
      <box>
        <Status mode="busy" items={['a', 'b']} />
        <input ref={(node) => (editor = node)} value="" />
      </box>
    ),
    window,
    options
  )
  await root.ready
  await root.flush()
  const listeners: number = root.diagnostics.listeners
  const state = editor ? inputState(editor) : undefined
  await root.dispose()
  await root.closed
  void listeners

  // @ts-expect-error Solid renders a component function, not an evaluated element.
  render(<box />, window)
  // @ts-expect-error Solid roots mount into a native window, not a DOM element.
  render(() => <box />, { nodeType: 1 })
  // @ts-expect-error Root styles are native dimensions, not CSS lengths.
  render(() => <box />, window, { style: { height: '100vh' } })
  // @ts-expect-error Root diagnostics are an immutable snapshot.
  root.diagnostics.commits = 0
  return state
}

export function checkComponentProps(): JSX.Element[] {
  return [
    // @ts-expect-error A component prop keeps its declared literal union.
    <Status mode="paused" items={[]} />,
    // @ts-expect-error Required component props cannot be omitted.
    <Status mode="idle" />,
    // @ts-expect-error A ref receives an adapter-owned node, not a core native handle.
    <input ref={(node: NativeNode<'input'>) => void node} />,
    // @ts-expect-error Placeholders are text, not numbers.
    <input placeholder={0} />,
  ]
}

export function checkInputState(handle: NativeNode<'input'>, node: SolidNode): InputState {
  const state = inputState(node)
  // @ts-expect-error Observed input revisions cannot be edited in place.
  state.revision = 0
  // @ts-expect-error Solid refs are renderer nodes, not core native handles.
  inputState(handle)
  return state
}

export function checkCompilerHelpers(): SolidNode {
  // These helpers are the universal compiler's contract and operate on renderer nodes.
  const box: SolidNode = createElement('box')
  const text: SolidNode = createTextNode('Compiled')
  insert(box, text)
  setProp(box, 'style', { gap: 2 })
  const Label = (props: { readonly label: string }): SolidNode => createTextNode(props.label)
  const element: JSX.Element = createComponent(Label, { label: 'Compiled component' })
  const runtimeElement: RuntimeJSX.Element = element
  // @ts-expect-error The compiler helper still checks component props.
  createComponent(Label, { label: 1 })
  // @ts-expect-error Text nodes hold strings.
  createTextNode(1)
  void runtimeElement
  return box
}

// @ts-expect-error The jsx-runtime namespace has no DOM intrinsic elements.
export const RuntimeDiv: RuntimeJSX.IntrinsicElements['div'] = {}
