/** Compile-only contract for the shared renderer exports used by both framework adapters. */
import type { InputState, NativeNode, NativeWindow } from '@bun-native/core'
import {
  asNode,
  createElement,
  createRenderRoot,
  createTextNode,
  eventProperties,
  inputState,
  insertNode,
  isEventProperty,
  removeNode,
  replaceText,
  setProperty,
  type EventHandlers,
  type EventProperty,
  type Node,
  type RenderContext,
  type RendererNode,
  type RenderOptions,
  type RenderRoot,
} from '@bun-native/renderer'

export const properties: readonly EventProperty[] = [
  'onClick',
  'onClickCapture',
  'onInputCapture',
  'onKeyUp',
  'onPointerDownCapture',
  'onBlurCapture',
]
// @ts-expect-error DOM change events are not native event properties.
export const change: EventProperty = 'onChange'
// @ts-expect-error Pointer moves are not in the supported native event table.
export const pointerMove: EventProperty = 'onPointerMove'

export function checkEventTable(name: string): void {
  const click: { readonly type: 'click'; readonly capture: boolean } = eventProperties.onClick
  const keyUp: 'key_up' = eventProperties.onKeyUpCapture.type
  void [click, keyUp]
  if (isEventProperty(name)) {
    const property: EventProperty = name
    void property
  }
  // @ts-expect-error The shared event table is frozen.
  eventProperties.onClick = eventProperties.onInput
  // @ts-expect-error A binding's capture phase is fixed.
  eventProperties.onFocus.capture = true
}

export const handlers: EventHandlers = {
  onClick: (event) => void event.signal.aborted,
  onInputCapture: (event) => void event.revision,
  onKeyDown: (event) => void event.modifiers.platform,
  onPointerUp: async (event) => void event.button,
  onBlur: (event) => void event.phase,
}
// @ts-expect-error An input handler receives committed input, not a click event.
export const wrongPayload: EventHandlers = { onInput: (event: { type: 'click' }) => void event }
// @ts-expect-error Click events carry no input value.
export const clickValue: EventHandlers = { onClick: (event) => void event.value }
// @ts-expect-error Handlers are callables, not inline script strings.
export const stringHandler: EventHandlers = { onFocus: 'focus()' }

export function checkNodes(reference: RendererNode, handle: NativeNode<'input'>): InputState {
  const box: Node = createElement('box')
  const text: Node = createTextNode('Literal')
  insertNode(box, text)
  insertNode(box, createElement('input'), text)
  replaceText(text, 'Replaced')
  setProperty(box, 'style', { gap: 4 })
  removeNode(box, text)
  const node: Node = asNode(reference)
  const kind: 'box' | 'text' | 'button' | 'input' | 'text-node' = node.kind
  const state: InputState = inputState(reference)
  const owned: RendererNode = box
  void [kind, owned]

  // @ts-expect-error A core native handle is not an adapter-owned renderer node.
  inputState(handle)
  // @ts-expect-error A plain object cannot manufacture a renderer node identity.
  inputState({ kind: 'input' })
  // @ts-expect-error A renderer reference is not a staged node until checked with asNode.
  insertNode(box, reference)
  // @ts-expect-error A staged node's kind is fixed at creation.
  node.kind = 'text'
  // @ts-expect-error Text content is a string.
  replaceText(text, 42)
  return state
}

export function checkRoot(window: NativeWindow): RenderRoot {
  const options: RenderOptions = { style: { width: 'fill', overflow: 'scroll_y' } }
  const root = createRenderRoot(
    window,
    (context: RenderContext) => {
      const container: Node = context.container
      context.onCleanup(() => {})
      context.fail(new Error('Unrecovered framework error'))
      void container
    },
    options
  )
  const ready: Promise<void> = root.ready
  const closed: Promise<void> = root.closed
  const counts: readonly [number, number, number, boolean] = [
    root.diagnostics.nodes,
    root.diagnostics.listeners,
    root.diagnostics.commits,
    root.diagnostics.pending,
  ]
  void root.flush()
  void root.dispose()
  void [ready, closed, counts]

  // @ts-expect-error The render callback receives an owned context, not a window.
  createRenderRoot(window, (context: NativeWindow) => void context)
  // @ts-expect-error Root styles use native dimensions, not CSS lengths.
  createRenderRoot(window, () => {}, { style: { width: '100vw' } })
  // @ts-expect-error Render options are limited to the container style.
  createRenderRoot(window, () => {}, { strict: true })
  // @ts-expect-error The ready promise cannot be replaced.
  root.ready = Promise.resolve()
  // @ts-expect-error Root diagnostics are an immutable snapshot.
  root.diagnostics.nodes = 0
  return root
}
