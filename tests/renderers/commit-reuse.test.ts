import { expect, test } from 'bun:test'
import type { Element, NativeBatch, NativeWindow } from '@bun-native/core'
import {
  createElement,
  createRenderRoot,
  createTextNode,
  insertNode,
  removeNode,
  replaceText,
  setProperty,
  type Node,
} from '@bun-native/renderer'
import { withApp } from './support.ts'

/** Record each native element the renderer sends through an actual core batch. */
function recordSets(window: NativeWindow) {
  const sets: Element[] = []
  const recorded: NativeWindow = {
    root: window.root,
    get closed() {
      return window.closed
    },
    get revision() {
      return window.revision
    },
    batch: (update) =>
      window.batch((batch) => {
        const observed: NativeBatch = {
          create: (element) => batch.create(element),
          set: ((node: never, element: Element, revision?: number) => {
            sets.push(element)
            ;(batch.set as (...values: unknown[]) => void)(node, element, revision)
          }) as NativeBatch['set'],
          insert: (parent, child, index) => batch.insert(parent, child, index),
          append: (parent, child) => batch.append(parent, child),
          remove: (node) => batch.remove(node),
        }
        return update(observed)
      }),
    close: window.close.bind(window),
    displaySnapshot: window.displaySnapshot.bind(window),
    readClipboardText: window.readClipboardText.bind(window),
    writeClipboardText: window.writeClipboardText.bind(window),
    registerGlobalShortcut: window.registerGlobalShortcut.bind(window),
    postNotification: window.postNotification.bind(window),
    input: window.input.bind(window),
    on: window.on.bind(window),
    onClick: window.onClick.bind(window),
    onInput: window.onInput.bind(window),
  }
  return { window: recorded, sets }
}

test('each mutation path resends exactly its affected element and nothing else', () =>
  withApp(async (app) => {
    const { window, sets } = recordSets(await app.openWindow({ title: 'Renderer reuse' }))
    const label = createElement('text')
    const literal = createTextNode('Before')
    const button = createElement('button')
    const panel = createElement('box')
    const field = createElement('input')
    const root = createRenderRoot(window, ({ container }) => {
      insertNode(label, literal)
      setProperty(button, 'text', 'Accept')
      setProperty(panel, 'style', { padding: 4 })
      setProperty(field, 'placeholder', 'Type')
      insertNode(panel, field)
      for (const child of [label, button, panel]) insertNode(container, child)
    })
    await root.ready
    const commits = root.diagnostics.commits
    expect(sets).toEqual([])

    replaceText(literal, 'After')
    await root.flush()
    expect(sets.splice(0)).toEqual([{ kind: 'text', text: 'After' }])

    setProperty(button, 'disabled', true)
    await root.flush()
    expect(sets.splice(0)).toEqual([{ kind: 'button', text: 'Accept', disabled: true }])

    setProperty(panel, 'style', { padding: 8 })
    await root.flush()
    expect(sets.splice(0)).toEqual([{ kind: 'box', style: { padding: 8 } }])

    setProperty(field, 'placeholder', 'Search')
    await root.flush()
    expect(sets.splice(0)).toEqual([{ kind: 'input', value: '', placeholder: 'Search' }])

    // An equal replacement recaptures the node but sends no native command.
    setProperty(panel, 'style', { padding: 8 })
    replaceText(literal, 'After')
    await root.flush()
    expect(sets).toEqual([])
    expect(root.diagnostics.commits).toBe(commits + 4)
    expect(root.diagnostics.mutations.set).toBe(4)
    await root.dispose()
  }))

test('a reinserted subtree is recaptured with direct edits and reregistered listeners', () =>
  withApp(async (app) => {
    const { window, sets } = recordSets(await app.openWindow({ title: 'Renderer reinsert' }))
    const row = createElement('box')
    const label = createElement('text')
    const literal = createTextNode('Row')
    const button = createElement('button')
    let container!: Node
    const root = createRenderRoot(window, (context) => {
      container = context.container
      insertNode(label, literal)
      setProperty(button, 'onClick', () => {})
      insertNode(row, label)
      insertNode(row, button)
      insertNode(container, row)
    })
    await root.ready
    expect(root.diagnostics.listeners).toBe(1)
    expect(app.diagnostics.callbacks).toBe(1)

    // Detaching revokes listeners even when the same subtree returns before commit.
    removeNode(container, row)
    insertNode(container, row)
    expect(root.diagnostics.listeners).toBe(0)
    await root.flush()
    expect(root.diagnostics.listeners).toBe(1)
    expect(app.diagnostics.callbacks).toBe(1)
    expect(sets).toEqual([])

    // Adapters may clear a detached node directly; reinsertion observes it.
    removeNode(container, row)
    // Detached captures release their listener references.
    for (const node of [row, label, literal, button]) expect(node.captured).toBeUndefined()
    literal.data = 'Edited while detached'
    insertNode(container, row)
    await root.flush()
    expect(sets.splice(0)).toEqual([{ kind: 'text', text: 'Edited while detached' }])
    expect(root.diagnostics.nodes).toBe(4)
    await root.dispose()
  }))
