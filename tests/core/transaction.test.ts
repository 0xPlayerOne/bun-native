import { describe, expect, test } from 'bun:test'
import type { Limits } from '@bun-native/protocol'
import { makeNode, Transaction, type NodeState } from '../../packages/core/src/tree.ts'
import type { NativeNode } from '../../packages/core/src/types.ts'

const limits = {
  max_operations: 64,
  max_nodes_per_window: 64,
  max_depth: 3,
  max_text_bytes: 8,
  max_text_bytes_per_window: 12,
} as Readonly<Limits>

function committed() {
  let next = 1
  const root = makeNode(next++, { kind: 'box' })
  const first = new Transaction(new Map([[root.id, root]]), root.id, () => next++, limits)
  const box = first.create({ kind: 'box' })
  const label = first.create({ kind: 'text', text: 'abc' })
  first.append(root.handle as NativeNode<'box'>, box)
  first.append(box, label)
  first.validate()
  first.finish()
  const snapshot = (nodes: ReadonlyMap<number, NodeState>) =>
    structuredClone(
      [...nodes.values()].map(({ id, element, parent, children, inputRevision }) => ({
        id,
        element,
        parent,
        children,
        inputRevision,
      }))
    )
  return {
    nodes: first.nodes,
    root: root.handle as NativeNode<'box'>,
    box,
    label,
    snapshot,
    begin: (nodes: ReadonlyMap<number, NodeState>) =>
      new Transaction(nodes, root.id, () => next++, limits),
  }
}

describe('native transaction candidate graph', () => {
  test('writes never reach the committed graph it was built from', () => {
    const { nodes, root, box, label, snapshot, begin } = committed()
    const before = snapshot(nodes)
    const candidate = begin(nodes)
    candidate.set(label, { kind: 'text', text: 'xyz' })
    candidate.insert(root, label, 0)
    const extra = candidate.create({ kind: 'text', text: 'q' })
    candidate.append(box, extra)
    candidate.remove(box)
    candidate.validate()
    expect(snapshot(nodes)).toEqual(before)
    expect([...candidate.nodes.keys()].sort()).toEqual([1, 3])
    expect(candidate.nodes.get(1)!.children).toEqual([3])
    expect(candidate.nodes.get(3)!.element).toEqual({ kind: 'text', text: 'xyz', style: {} })
  })

  test('shares untouched nodes and copies a node only on its first write', () => {
    const { nodes, label, begin } = committed()
    const candidate = begin(nodes)
    expect(candidate.nodes.get(2)).toBe(nodes.get(2))
    candidate.set(label, { kind: 'text', text: 'one' })
    const copy = candidate.nodes.get(3)
    expect(copy).not.toBe(nodes.get(3))
    candidate.set(label, { kind: 'text', text: 'two' })
    expect(candidate.nodes.get(3)).toBe(copy)
    expect(candidate.nodes.get(2)).toBe(nodes.get(2))
  })

  test('moves a child within one parent from a reference taken before the copy', () => {
    const { nodes, root, box, begin } = committed()
    const candidate = begin(nodes)
    const sibling = candidate.create({ kind: 'box' })
    candidate.append(root, sibling)
    candidate.insert(root, box, 1)
    expect(candidate.nodes.get(1)!.children).toEqual([4, 2])
    candidate.insert(root, sibling, 1)
    expect(candidate.nodes.get(1)!.children).toEqual([2, 4])
    expect(nodes.get(1)!.children).toEqual([2])
  })

  test('validates per-text and per-window bytes from replaced elements', () => {
    const { nodes, box, label, begin } = committed()
    const oversize = begin(nodes)
    oversize.set(label, { kind: 'text', text: '€€€' })
    expect(() => oversize.validate()).toThrow('Native text limit exceeded')
    const total = begin(nodes)
    total.set(label, { kind: 'text', text: '12345678' })
    total.append(box, total.create({ kind: 'text', text: '12345' }))
    expect(() => total.validate()).toThrow('Window text memory limit exceeded')
    const fits = begin(nodes)
    fits.set(label, { kind: 'text', text: '1234567' })
    fits.append(box, fits.create({ kind: 'text', text: '12345' }))
    expect(() => fits.validate()).not.toThrow()
  })

  test('checks depth level by level and requires every node to be attached', () => {
    const { nodes, box, begin } = committed()
    const deep = begin(nodes)
    let parent = box
    for (let depth = 2; depth <= 4; depth += 1) {
      const child = deep.create({ kind: 'box' })
      deep.append(parent, child)
      parent = child
    }
    expect(() => deep.validate()).toThrow('Native tree depth limit exceeded')
    const detached = begin(nodes)
    detached.create({ kind: 'box' })
    expect(() => detached.validate()).toThrow('Every created node must be attached before commit')
  })
})
