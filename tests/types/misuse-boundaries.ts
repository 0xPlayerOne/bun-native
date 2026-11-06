/**
 * Compile-only misuse checks for global shortcut options, the shared renderer
 * node functions and the protocol's shortcut key table. Each expectation below
 * is a misuse TypeScript already rejects; misuses the types still accept are
 * rejected at runtime and covered by unit tests instead.
 */
import type { GlobalShortcutOptions, NativeNode, NativeWindow } from '@bun-native/core'
import { GLOBAL_SHORTCUT_KEYS } from '@bun-native/protocol'
import {
  asNode,
  createElement,
  createTextNode,
  insertNode,
  setProperty,
  type Node,
  type RendererNode,
} from '@bun-native/renderer'

export async function checkShortcutOptions(window: NativeWindow): Promise<void> {
  const options: GlobalShortcutOptions = { key: 'k', alt: true, platform: true }
  void options

  // @ts-expect-error A shortcut must name its key.
  const keyless: GlobalShortcutOptions = { control: true }
  // @ts-expect-error A key is a layout-level name, not a key code.
  const keyCode: GlobalShortcutOptions = { key: 75, control: true }
  // @ts-expect-error Modifier names are control, alt, shift and platform only.
  const meta: GlobalShortcutOptions = { key: 'k', meta: true }
  // @ts-expect-error Modifiers are flat options, not a nested record.
  const nested: GlobalShortcutOptions = { key: 'k', modifiers: { control: true } }
  // @ts-expect-error Options are read-only once built.
  options.key = 'j'
  // @ts-expect-error A modifier cannot be switched on after construction.
  options.control = true
  // @ts-expect-error A registration requires its options.
  await window.registerGlobalShortcut(() => {})
  // @ts-expect-error A registration requires an activation listener.
  await window.registerGlobalShortcut(options)
  void [keyless, keyCode, meta, nested]
}

export function checkRendererCalls(reference: RendererNode, handle: NativeNode<'box'>): void {
  const box: Node = createElement('box')
  setProperty(box, 'text', 'Label')

  // @ts-expect-error A native element tag is a string.
  createElement(1)
  // @ts-expect-error An element needs a tag.
  createElement()
  // @ts-expect-error Text node content is a string.
  createTextNode(1)
  // @ts-expect-error Property names are strings.
  setProperty(box, 1, 'Label')
  // @ts-expect-error A property update states its value, even when clearing it.
  setProperty(box, 'text')
  // @ts-expect-error A renderer reference must be checked with asNode before mutation.
  setProperty(reference, 'text', 'Label')
  // @ts-expect-error A core native handle is not a staged renderer node.
  setProperty(handle, 'text', 'Label')
  // @ts-expect-error A plain object is not a staged node.
  insertNode({ kind: 'box' }, box)
}

export function checkNodeMutability(reference: RendererNode, handle: NativeNode<'box'>): void {
  const node: Node = asNode(reference)
  const children: Node[] = node.children
  void children

  // @ts-expect-error The staged child list is replaced only by its own mutations.
  node.staged = []
  // @ts-expect-error The property record is owned by setProperty.
  node.properties = {}
  // @ts-expect-error Staged text is a string.
  node.properties.text = 1
  // @ts-expect-error A disabled flag is a boolean.
  node.properties.disabled = 'true'
  // @ts-expect-error The children view is derived from the staged list.
  node.children = []
  // @ts-expect-error A core native handle cannot be checked into a renderer node.
  asNode(handle)
  // @ts-expect-error A plain object cannot manufacture a renderer node identity.
  asNode({ kind: 'box' })
  // @ts-expect-error asNode requires a reference.
  asNode()
}

export function checkShortcutKeyTable(): void {
  const first: string | undefined = GLOBAL_SHORTCUT_KEYS[0]
  const known: boolean = GLOBAL_SHORTCUT_KEYS.includes('k')
  void [first, known]

  // @ts-expect-error The key table is read-only.
  GLOBAL_SHORTCUT_KEYS[0] = 'escape'
  // @ts-expect-error The key table cannot be truncated.
  GLOBAL_SHORTCUT_KEYS.length = 0
  // @ts-expect-error The key table cannot be reordered in place.
  GLOBAL_SHORTCUT_KEYS.sort()
  // @ts-expect-error Entries cannot be removed.
  GLOBAL_SHORTCUT_KEYS.splice(0, 1)
}
