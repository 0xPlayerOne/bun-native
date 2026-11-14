import { expect, test } from 'bun:test'
import type { Element, NativeBatch, NativeNode, NativeWindow } from '@bun-native/core'
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

type Model = { element: Element; parent: Model | undefined; children: Model[]; listeners: number }

/**
 * In-process window that applies each acknowledged batch to a native tree
 * model, so the incremental diff can be compared with a full staged tree.
 * Batches run a macrotask after they are queued, like a busy core queue.
 */
function modelWindow() {
  const nodes = new Map<number, Model>()
  const ops = { create: 0, set: 0, insert: 0, remove: 0 }
  const removedHandles: NativeNode[] = []
  let id = 0
  let reject = false
  const top: Model = { element: { kind: 'box' }, parent: undefined, children: [], listeners: 0 }
  const handle = (model: Model, kind: string) => {
    const value = { kind, id: ++id } as unknown as NativeNode
    nodes.set(id, model)
    return value
  }
  const root = handle(top, 'box')
  const get = (node: NativeNode) => {
    const model = nodes.get((node as unknown as { id: number }).id)
    if (!model) throw new Error('Unknown native node')
    return model
  }
  const detach = (model: Model) => {
    if (model.parent) model.parent.children.splice(model.parent.children.indexOf(model), 1)
    model.parent = undefined
  }
  const attach = (parent: Model, child: Model, index: number) => {
    detach(child)
    if (index < 0 || index > parent.children.length) throw new Error('Insert index out of range')
    parent.children.splice(index, 0, child)
    child.parent = parent
  }
  const release = (model: Model) => {
    for (const [key, value] of nodes) if (value === model) nodes.delete(key)
    for (const child of model.children) release(child)
  }
  const window = {
    root,
    closed: new Promise<void>(() => {}),
    revision: 0,
    async batch<T>(update: (batch: NativeBatch) => T): Promise<T> {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (reject) {
        reject = false
        throw new Error('Rejected native batch')
      }
      // Apply only after the whole update succeeds, like an atomic transaction.
      const pending: (() => void)[] = []
      const batch: NativeBatch = {
        create: (element) => {
          ops.create += 1
          const model: Model = { element, parent: undefined, children: [], listeners: 0 }
          return handle(model, element.kind) as never
        },
        set: ((node: NativeNode, element: Element) => {
          ops.set += 1
          pending.push(() => (get(node).element = element))
        }) as NativeBatch['set'],
        insert: (parent, child, index) => {
          ops.insert += 1
          pending.push(() => attach(get(parent), get(child), index))
        },
        append: (parent, child) => {
          ops.insert += 1
          pending.push(() => attach(get(parent), get(child), get(parent).children.length))
        },
        remove: (node) => {
          ops.remove += 1
          removedHandles.push(node)
          pending.push(() => {
            const model = get(node)
            detach(model)
            release(model)
          })
        },
        focus: () => {},
        scrollTo: () => {},
        scrollIntoView: () => {},
      }
      const result = update(batch)
      for (const apply of pending) apply()
      return result
    },
    on(node: NativeNode) {
      const model = get(node)
      model.listeners += 1
      return () => (model.listeners -= 1)
    },
    input: () => ({ value: '', revision: 0 }),
    close: async () => {},
  } as unknown as NativeWindow
  return {
    window,
    ops,
    removedHandles,
    rejectNext: () => (reject = true),
    native: () => top.children,
  }
}

type Shape = { kind: string; text?: string; listeners: number; children: Shape[] }

function nativeShape(model: Model): Shape {
  const element = model.element
  return {
    kind: element.kind,
    ...('text' in element ? { text: element.text } : {}),
    listeners: model.listeners,
    children: model.children.map(nativeShape),
  }
}

function stagedShape(node: Node): Shape {
  const listeners = node.properties.onClick ? 1 : 0
  if (node.kind === 'text-node') return { kind: 'text', text: node.data, listeners, children: [] }
  if (node.kind === 'text')
    return {
      kind: 'text',
      text: node.children.map((child) => child.data).join(''),
      listeners,
      children: [],
    }
  if (node.kind === 'button')
    return { kind: 'button', text: node.properties.text ?? '', listeners, children: [] }
  return { kind: node.kind, listeners, children: node.children.map(stagedShape) }
}

function count(shape: Shape): number {
  return shape.children.reduce((total, child) => total + count(child), 1)
}

/** Deterministic xorshift so a failure names a reproducible seed. */
function random(seed: number) {
  let state = seed || 1
  return (limit: number) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % limit
  }
}

// Wide variants start with many root children, so most commits visit only the
// registered dirty children of a current parent, and also reinsert detached
// subtrees and edit several siblings out of order in one batch.
const variants = [
  ...[1, 7, 42, 1234, 99991].map((seed) => ({ seed, width: 0 })),
  ...[3, 77, 4242].map((seed) => ({ seed, width: 96 })),
]
for (const { seed, width } of variants) {
  test(`incremental commits converge on the staged tree (seed ${seed}, width ${width})`, async () => {
    const next = random(seed)
    const model = modelWindow()
    let container!: Node
    const detached: Node[] = []
    const root = createRenderRoot(model.window, (context) => {
      container = context.container
      for (let index = 0; index < width; index += 1) {
        const text = createElement('text')
        insertNode(text, createTextNode('w' + index))
        insertNode(container, text)
      }
    })
    await root.ready
    const live = () => {
      const found: Node[] = []
      const walk = (node: Node) => {
        found.push(node)
        if (node.kind === 'box') for (const child of node.children) walk(child)
      }
      walk(container)
      return found
    }
    const boxes = () => live().filter((node) => node.kind === 'box')
    const fresh = (): Node => {
      const choice = next(4)
      if (choice === 0) {
        const box = createElement('box')
        for (let index = next(3); index > 0; index -= 1) insertNode(box, fresh())
        return box
      }
      if (choice === 1) {
        const button = createElement('button')
        setProperty(button, 'text', 'b' + next(100))
        if (next(2)) setProperty(button, 'onClick', () => {})
        return button
      }
      const text = createElement('text')
      insertNode(text, createTextNode('t' + next(100)))
      return text
    }
    const mutate = () => {
      const all = live()
      const parents = boxes()
      const target = all[next(all.length)]!
      const parent = parents[next(parents.length)]!
      const anchor = parent.children.length
        ? parent.children[next(parent.children.length)]
        : undefined
      switch (next(width ? 8 : 6)) {
        case 0:
          insertNode(parent, fresh(), next(2) ? anchor : undefined)
          break
        case 1: {
          // Keyed move, including out of a subtree that a later mutation removes.
          if (target === container || target === anchor) break
          let cycle = false
          for (let node: Node | undefined = parent; node; node = node.parent)
            if (node === target) cycle = true
          if (!cycle) insertNode(parent, target, anchor?.parent === parent ? anchor : undefined)
          break
        }
        case 2:
          if (target !== container) {
            removeNode(target.parent!, target)
            if (width) detached.push(target)
          }
          break
        case 3:
          if (target.kind === 'text' && target.children[0])
            replaceText(target.children[0], 'r' + next(100))
          break
        case 4:
          if (target.kind === 'button')
            setProperty(target, 'onClick', next(2) ? () => {} : undefined)
          break
        case 6: {
          // Reinsert a detached subtree, possibly into its former parent.
          const node = detached.splice(next(detached.length + 1), 1)[0]
          if (node) insertNode(parent, node, next(2) ? anchor : undefined)
          break
        }
        case 7: {
          // Several sibling edits in one batch, made in reverse child order.
          const texts = parent.children.filter((child) => child.kind === 'text')
          for (let index = texts.length - 1; index >= 0; index -= 1)
            if (next(3) === 0 && texts[index]!.children[0])
              replaceText(texts[index]!.children[0]!, 's' + next(100))
          break
        }
        default:
          setProperty(parent, 'style', { padding: next(4) })
      }
    }
    for (let round = 0; round < 60; round += 1) {
      for (let index = next(5); index >= 0; index -= 1) mutate()
      const flushed = root.flush()
      // Mutations while a batch is queued belong to the next batch.
      if (next(2)) mutate()
      await flushed
      await root.flush()
      const expected = stagedShape(container)
      expect(model.native().map(nativeShape)).toEqual([expected])
      expect(root.diagnostics.nodes).toBe(count(expected))
      const listeners = live().filter((node) => node.properties.onClick).length
      expect(root.diagnostics.listeners).toBe(listeners)
    }
    await root.dispose()
    expect(model.native()).toEqual([])
  })
}

test('a deep single-node edit sends one command and reuses every clean record', async () => {
  const model = modelWindow()
  const literals: Node[] = []
  const root = createRenderRoot(model.window, ({ container }) => {
    let parent = container
    for (let depth = 0; depth < 20; depth += 1) {
      const box = createElement('box')
      for (let index = 0; index < 20; index += 1) {
        const text = createElement('text')
        const literal = createTextNode(depth + ':' + index)
        insertNode(text, literal)
        insertNode(box, text)
        literals.push(literal)
      }
      insertNode(parent, box)
      parent = box
    }
  })
  await root.ready
  const before = { ...model.ops }
  replaceText(literals.at(-1)!, 'changed')
  await root.flush()
  expect(model.ops).toEqual({ ...before, set: before.set + 1 })
  expect(root.diagnostics.nodes).toBe(1 + 20 * 21)
  await root.dispose()
})

test('a rejected batch publishes nothing and cleanup removes the acknowledged root', async () => {
  const model = modelWindow()
  const rows: Node[] = []
  let container!: Node
  const root = createRenderRoot(model.window, (context) => {
    container = context.container
    for (let index = 0; index < 3; index += 1) {
      const button = createElement('button')
      setProperty(button, 'text', String(index))
      setProperty(button, 'onClick', () => {})
      insertNode(container, button)
      rows.push(button)
    }
  })
  await root.ready
  expect(root.diagnostics).toMatchObject({ nodes: 4, listeners: 3 })
  model.rejectNext()
  removeNode(container, rows[0]!)
  insertNode(container, createElement('box'))
  await expect(root.flush()).rejects.toThrow('Rejected native batch')
  await expect(root.closed).rejects.toThrow('Rejected native batch')
  // The failed batch neither created the box nor removed the row natively;
  // cleanup removed the root through its acknowledged handle.
  expect(model.native()).toEqual([])
  expect(model.ops.remove).toBe(1)
  expect(root.diagnostics).toMatchObject({ nodes: 0, listeners: 0 })
})

test('a subtree moved within its live root recaptures only its own root', async () => {
  const model = modelWindow()
  const groups: Node[] = []
  const literals: Node[] = []
  const moved = createElement('box')
  let container!: Node
  const root = createRenderRoot(model.window, (context) => {
    container = context.container
    for (let index = 0; index < 2; index += 1) {
      const group = createElement('box')
      insertNode(container, group)
      groups.push(group)
    }
    for (let index = 0; index < 10; index += 1) {
      const row = createElement('box')
      const text = createElement('text')
      const literal = createTextNode('row ' + index)
      insertNode(text, literal)
      insertNode(row, text)
      const button = createElement('button')
      setProperty(button, 'text', 'select')
      setProperty(button, 'onClick', () => {})
      insertNode(row, button)
      insertNode(moved, row)
      literals.push(literal)
    }
    insertNode(groups[0]!, moved)
  })
  await root.ready
  const descendants: Node[] = []
  const walk = (node: Node) => {
    for (const child of node.children) {
      descendants.push(child)
      walk(child)
    }
  }
  walk(moved)
  const captures = descendants.map((node) => node.captured)
  const converge = () => {
    const expected = stagedShape(container)
    expect(model.native().map(nativeShape)).toEqual([expected])
    expect(root.diagnostics.nodes).toBe(count(expected))
    expect(root.diagnostics.listeners).toBe(10)
  }

  // A move with an edit below it in the same batch: one insert, one set.
  let before = { ...model.ops }
  insertNode(groups[1]!, moved)
  replaceText(literals[3]!, 'edited')
  await root.flush()
  expect(model.ops).toEqual({ ...before, insert: before.insert + 1, set: before.set + 1 })
  converge()
  descendants.forEach((node, index) => {
    // The edited literal's text element was recaptured; nothing else below moved.
    if (node === literals[3] || node === literals[3]!.parent) return
    expect(node.captured).toBe(captures[index])
  })

  // Moving it out of a group that leaves in the same batch rescues it intact.
  const kept = descendants.map((node) => node.captured)
  before = { ...model.ops }
  insertNode(container, moved, groups[0])
  removeNode(container, groups[1]!)
  await root.flush()
  // The rescue parks it under the root before the removal, then places it.
  expect(model.ops).toEqual({ ...before, insert: before.insert + 2, remove: before.remove + 1 })
  converge()
  descendants.forEach((node, index) => expect(node.captured).toBe(kept[index]))

  // Moved back into a group after removal from the tree, it is recaptured whole.
  removeNode(container, moved)
  insertNode(groups[0]!, moved)
  await root.flush()
  converge()
  descendants.forEach((node, index) => {
    // Text literals are joined into their element's capture, never captured alone.
    if (node.kind !== 'text-node') expect(node.captured).not.toBe(kept[index])
  })
  await root.dispose()
  expect(model.native()).toEqual([])
})

test('removing a suffix rescues a retained descendant before deleting its ancestor', async () => {
  const model = modelWindow()
  const keep = createElement('box')
  const first = createElement('box')
  const last = createElement('box')
  const rescued = createElement('text')
  insertNode(rescued, createTextNode('retained'))
  insertNode(last, rescued)
  let container!: Node
  const root = createRenderRoot(model.window, (context) => {
    container = context.container
    insertNode(container, keep)
    insertNode(container, first)
    insertNode(container, last)
  })
  await root.ready
  const handle = rescued.handle
  const firstHandle = first.handle
  const lastHandle = last.handle
  if (!handle || !firstHandle || !lastHandle) throw new Error('Initial handles are missing')
  insertNode(keep, rescued)
  removeNode(container, first)
  removeNode(container, last)
  await root.flush()
  expect(model.removedHandles).toEqual([lastHandle, firstHandle])
  expect(rescued.handle).toBe(handle)
  expect(model.native().map(nativeShape)).toEqual([stagedShape(container)])
  await root.dispose()
})

test('detached subtrees rearranged among themselves mount from their current state', async () => {
  const model = modelWindow()
  let container!: Node
  const root = createRenderRoot(model.window, (context) => {
    container = context.container
  })
  await root.ready
  const label = (text: string) => {
    const node = createElement('text')
    insertNode(node, createTextNode(text))
    return node
  }
  // Built bottom-up while detached, as React does, then edited and moved
  // between detached parents before any owner takes it.
  const inner = createElement('box')
  const first = label('one')
  const second = label('two')
  insertNode(inner, first)
  insertNode(inner, second)
  const outer = createElement('box')
  insertNode(outer, inner)
  const other = createElement('box')
  insertNode(other, first)
  replaceText(second.children[0]!, 'two edited')
  setProperty(inner, 'style', { padding: 2 })
  const button = createElement('button')
  setProperty(button, 'text', 'go')
  setProperty(button, 'onClick', () => {})
  insertNode(inner, button, second)
  removeNode(outer, inner)
  insertNode(other, inner)
  insertNode(container, other)
  insertNode(container, outer)
  await root.flush()
  const expected = stagedShape(container)
  expect(expected.children.map((child) => child.children.length)).toEqual([2, 0])
  expect(model.native().map(nativeShape)).toEqual([expected])
  expect(root.diagnostics).toMatchObject({ nodes: count(expected), listeners: 1 })
  // Moving the mounted subtree back out and in again keeps the tree exact.
  removeNode(container, other)
  insertNode(outer, other)
  await root.flush()
  expect(model.native().map(nativeShape)).toEqual([stagedShape(container)])
  await root.dispose()
  expect(model.native()).toEqual([])
})
