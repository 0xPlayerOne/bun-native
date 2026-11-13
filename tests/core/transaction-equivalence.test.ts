// Random batches, many of them rejected, against the whole-window-copy oracle:
// the same verdict for every operation and validation (code, message and the
// first failure in its walk order), the same candidate and committed graphs,
// and committed text totals that match a full recount, including native input
// edits between batches and while a batch is in flight.
import { describe, expect, test } from 'bun:test'
import type { Element, Limits } from '@bun-native/protocol'
import {
  CommittedText,
  makeNode,
  Transaction,
  type NodeState,
} from '../../packages/core/src/tree.ts'
import { NativeStateError, type NativeNode } from '../../packages/core/src/types.ts'
import { ReferenceTransaction } from './reference-transaction.ts'

const limits = {
  max_operations: 12,
  max_nodes_per_window: 24,
  max_depth: 4,
  max_text_bytes: 8,
  max_text_bytes_per_window: 24,
} as Readonly<Limits>

// Includes texts above the per-text limit and enough bytes to cross the window's.
const labels = ['', '', 'a', 'a', 'abcd', 'abcd', 'abcdefgh', '界', '界', 'abcdefghi', '€€€']

class Rng {
  constructor(private state: number) {}
  next(): number {
    this.state ^= this.state << 13
    this.state ^= this.state >>> 17
    this.state ^= this.state << 5
    return (this.state >>> 0) / 2 ** 32
  }
  below(bound: number): number {
    return Math.floor(this.next() * bound)
  }
  chance(percent: number): boolean {
    return this.below(100) < percent
  }
  pick<T>(items: readonly T[]): T {
    return items[this.below(items.length)]!
  }
}

type Verdict = { code: string; message: string } | undefined

function verdict(run: () => void): Verdict {
  try {
    run()
    return undefined
  } catch (error) {
    if (!(error instanceof NativeStateError)) throw error
    return { code: error.code, message: error.message }
  }
}

function snapshot(nodes: Iterable<[number, NodeState]>) {
  return [...nodes].map(([id, { element, parent, children, inputRevision }]) => ({
    id,
    element: structuredClone(element),
    parent,
    children: [...children],
    inputRevision,
  }))
}

function element(rng: Rng, kind: Element['kind']): Element {
  const label = rng.pick(labels)
  switch (kind) {
    case 'box':
      return { kind: 'box' }
    case 'text':
      return { kind: 'text', text: label }
    case 'button':
      return { kind: 'button', text: label }
    case 'input':
      return rng.chance(30)
        ? { kind: 'input', value: label, placeholder: rng.pick(labels) }
        : { kind: 'input', value: label }
    default:
      throw new Error('This equivalence test builds only boxes, text, buttons and inputs')
  }
}

const kinds: readonly Element['kind'][] = ['box', 'box', 'box', 'text', 'button', 'input']

/** One window held both ways: the oracle's replaced Map and the overlay's live Map. */
class Pair {
  private readonly rootId = 1
  private next = 2
  reference = new Map<number, NodeState>()
  readonly nodes = new Map<number, NodeState>()
  readonly text = new CommittedText(limits.max_text_bytes)
  /** Handles of removed nodes, per side, to exercise stale ownership. */
  private readonly stale: [NativeNode, NativeNode][] = []

  constructor() {
    const reference = makeNode(this.rootId, { kind: 'box' })
    const root = makeNode(this.rootId, { kind: 'box' })
    this.reference.set(this.rootId, reference)
    this.nodes.set(this.rootId, root)
    this.text.replace(this.rootId, undefined, root.element)
  }

  /** A native input edit, applied as the window applies one to its committed node. */
  edit(rng: Rng): void {
    const inputs = [...this.reference.values()].filter((node) => node.element.kind === 'input')
    if (!inputs.length) return
    const id = rng.pick(inputs).id
    const value = rng.pick(labels)
    const reference = this.reference.get(id)!
    const node = this.nodes.get(id)!
    expect(node.inputRevision).toBe(reference.inputRevision)
    reference.inputRevision += 1
    reference.element = { ...reference.element, value } as Element
    const next = { ...node.element, value } as Element
    this.text.replace(id, node.element, next)
    node.inputRevision += 1
    node.element = next
  }

  /** Runs one random batch on both sides; true when it was accepted and committed. */
  batch(rng: Rng, inFlightEdits: boolean): boolean {
    let referenceNext = this.next
    let next = this.next
    const reference = new ReferenceTransaction(
      this.reference,
      this.rootId,
      () => referenceNext++,
      limits
    )
    const candidate = new Transaction(this.nodes, this.rootId, () => next++, limits, [], this.text)
    const beforeReference = snapshot(this.reference)
    const before = snapshot(this.nodes)
    // Pairs of handles by node ID: [oracle's, overlay's].
    const handle = (id: number): [NativeNode, NativeNode] | undefined => {
      const a = reference.nodes.get(id)
      const b = candidate.nodes.get(id)
      expect(Boolean(a)).toBe(Boolean(b))
      return a && b ? [a.handle, b.handle] : undefined
    }
    const anyNode = (): [NativeNode, NativeNode] => {
      if (this.stale.length && rng.chance(5)) return rng.pick(this.stale)
      const ids = [...reference.nodes.keys()]
      const movable = ids.filter((id) => id !== this.rootId)
      return handle(rng.pick(movable.length && !rng.chance(5) ? movable : ids))!
    }
    // Boxes made in this batch, newest last, so chains grow past the depth limit.
    const made: [NativeNode, NativeNode][] = []
    const box = (): [NativeNode, NativeNode] => {
      if (made.length && rng.chance(50))
        return made[made.length - 1 - rng.below(Math.min(3, made.length))]!
      const ids = [...reference.nodes.values()]
        .filter((node) => node.element.kind === 'box' || rng.chance(3))
        .map((node) => node.id)
      return ids.length && !rng.chance(3) ? handle(rng.pick(ids))! : anyNode()
    }
    // Sometimes one past the operation bound.
    const count = 1 + rng.below(limits.max_operations + 2)
    for (let index = 0; index < count; index += 1) {
      const roll = rng.below(100)
      let run: (batch: ReferenceTransaction | Transaction, side: 0 | 1) => void
      if (roll < 40) {
        const value = element(rng, rng.pick(kinds))
        const parent = rng.chance(80) ? box() : undefined
        const pair: NativeNode[] = []
        run = (batch, side) => {
          pair[side] = batch.create(value)
          if (parent) batch.append(parent[side] as NativeNode<'box'>, pair[side])
        }
        if (value.kind === 'box') made.push(pair as [NativeNode, NativeNode])
      } else if (roll < 65) {
        const [node, kind] = [anyNode(), rng.chance(90) ? undefined : rng.pick(kinds)]
        const current = [...reference.nodes.values()].find((item) => item.handle === node[0])
        const value = element(rng, kind ?? current?.element.kind ?? 'text')
        const revision =
          value.kind === 'input'
            ? rng.chance(85)
              ? (current?.inputRevision ?? 0)
              : rng.below(3)
            : rng.chance(5)
              ? 0
              : undefined
        run = (batch, side) =>
          (batch as ReferenceTransaction).set(node[side], value, revision as number)
      } else if (roll < 90) {
        const parent = box()
        const child = anyNode()
        const append = rng.chance(50)
        const index = rng.below(4) - (rng.chance(5) ? 1 : 0)
        run = (batch, side) =>
          append
            ? batch.append(parent[side] as NativeNode<'box'>, child[side])
            : batch.insert(parent[side] as NativeNode<'box'>, child[side], index)
      } else {
        const node = anyNode()
        run = (batch, side) => batch.remove(node[side])
        // Once removed (or rejected alike), the pair still exercises ownership.
        this.stale.push(node)
        if (this.stale.length > 16) this.stale.shift()
      }
      const expected = verdict(() => run(reference, 0))
      const actual = verdict(() => run(candidate, 1))
      expect(actual).toEqual(expected)
      expect(candidate.nodes.size).toBe(reference.nodes.size)
      expect(next).toBe(referenceNext)
    }
    expect(snapshot(candidate.nodes)).toEqual(snapshot(reference.nodes))
    expect([...candidate.operations]).toEqual(reference.operations)
    const expected = verdict(() => reference.validate())
    const actual = verdict(() => candidate.validate())
    expect(actual).toEqual(expected)
    reference.finish()
    candidate.finish()
    // A rejected batch leaves the committed graph and its totals untouched.
    expect(snapshot(this.reference)).toEqual(beforeReference)
    expect(snapshot(this.nodes)).toEqual(before)
    if (expected) {
      this.check()
      return false
    }
    if (inFlightEdits) for (let edits = rng.below(3); edits > 0; edits -= 1) this.edit(rng)
    const shared = [...this.nodes].filter(([id]) => !candidate.nodes.writes.has(id))
    this.reference = reference.commitInto(this.reference)
    candidate.commit(this.nodes, this.text)
    // Untouched nodes stay shared, not copied, across the commit.
    for (const [id, node] of shared) if (this.nodes.has(id)) expect(this.nodes.get(id)).toBe(node)
    this.next = next
    this.check()
    return true
  }

  check(): void {
    expect(snapshot(this.nodes)).toEqual(snapshot(this.reference))
    const recount = new CommittedText(limits.max_text_bytes, this.nodes.values())
    expect(this.text.bytes).toBe(recount.bytes)
    expect([...this.text.oversized].sort()).toEqual([...recount.oversized].sort())
  }
}

describe('overlay transaction equivalence', () => {
  for (const seed of [0x1234567, 0x2bad5eed, 0x51ab1e, 0x7ee7ab1e]) {
    test(`matches the whole-window oracle for seed ${seed.toString(16)}`, () => {
      const rng = new Rng(seed)
      let accepted = 0
      let rejected = 0
      for (let round = 0; round < 25; round += 1) {
        const pair = new Pair()
        for (let step = 0; step < 40; step += 1) {
          if (rng.chance(20)) pair.edit(rng)
          if (pair.batch(rng, rng.chance(30))) accepted += 1
          else rejected += 1
        }
      }
      // Both verdicts must be common for the comparison to mean anything.
      expect(accepted).toBeGreaterThan(50)
      expect(rejected).toBeGreaterThan(50)
    })
  }

  test('rejects a commit to a graph the batch was not opened on', () => {
    const root = makeNode(1, { kind: 'box' })
    const nodes = new Map([[root.id, root]])
    const text = new CommittedText(limits.max_text_bytes, nodes.values())
    const batch = new Transaction(nodes, root.id, () => 2, limits, [], text)
    batch.append(root.handle as NativeNode<'box'>, batch.create({ kind: 'box' }))
    batch.validate()
    expect(() => batch.commit(new Map(nodes), text)).toThrow(
      'Batch commits only to the graph it was opened on'
    )
    batch.commit(nodes, text)
    expect(nodes.get(1)!.children).toEqual([2])
  })
})
