// Batches queued behind the one in flight run as one group (`runBatches`):
// each callback runs in its own transaction over the candidate before it, the
// group is sent as few native batches as the negotiated limits allow, and each
// caller settles with its own value or error, in order.
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  parseElement,
  REQUIRED_CAPABILITIES,
  type Element,
  type Limits,
  type Operation,
} from '@bun-native/protocol'
import { NativeCommandError } from '@bun-native/runtime'
import { runBatches, type BatchEntry, type BatchWindow } from '../../packages/core/src/batches.ts'
import {
  BATCH_ENVELOPE_BYTES,
  CommittedText,
  makeNode,
  Transaction,
  type NodeState,
} from '../../packages/core/src/tree.ts'
import {
  NativeStateError,
  type NativeBatch,
  type NativeNode,
} from '../../packages/core/src/types.ts'

/** A window whose native side applies every batch unless `refuse` names an error. */
class Window implements BatchWindow {
  readonly nodes = new Map<number, NodeState>()
  readonly text: CommittedText
  readonly root: NativeNode<'box'>
  readonly sent: Operation[][] = []
  revision = 0
  closed = false
  refuse: (operations: readonly Operation[]) => Error | undefined = () => undefined
  private next = 1
  private readonly rootId: number

  constructor(readonly limits: Readonly<Limits>) {
    const root = makeNode(this.next++, { kind: 'box' })
    this.rootId = root.id
    this.root = root.handle
    this.nodes.set(root.id, root)
    this.text = new CommittedText(limits.max_text_bytes, [root])
  }

  transaction(): Transaction {
    if (this.closed) throw new NativeStateError('invalid_handle', 'Window is closed')
    return new Transaction(
      this.nodes,
      this.rootId,
      () => this.next++,
      this.limits,
      [...REQUIRED_CAPABILITIES, 'focus_v1'],
      this.text
    )
  }

  async apply(transactions: readonly Transaction[]): Promise<void> {
    const operations = transactions.flatMap((transaction) => [...transaction.operations])
    this.sent.push(operations)
    await Promise.resolve()
    const error = this.refuse(operations)
    if (error) throw error
    for (const transaction of transactions) {
      if (transaction.nodes.base !== this.nodes) transaction.rebase(this.nodes, this.text)
      transaction.commit(this.nodes, this.text)
    }
    this.revision += 1
  }

  texts(): string[] {
    return [...this.nodes.values()].flatMap((node) =>
      node.element.kind === 'text' ? [node.element.text] : []
    )
  }
}

type Outcome = { index: number } & ({ value: unknown } | { error: unknown })

/** Run `updates` as one group and return every outcome in settlement order. */
async function group(
  window: Window,
  updates: readonly ((batch: NativeBatch) => unknown)[]
): Promise<Outcome[]> {
  const outcomes: Outcome[] = []
  const entries: BatchEntry[] = updates.map((update, index) => ({
    update,
    resolve: (value) => outcomes.push({ index, value }),
    reject: (error) => outcomes.push({ index, error }),
  }))
  const release = await runBatches(window, entries, window.limits)
  release()
  expect(outcomes.map((outcome) => outcome.index)).toEqual(updates.map((_, index) => index))
  return outcomes
}

const failed = (outcome: Outcome | undefined) =>
  outcome && 'error' in outcome ? outcome.error : undefined

/** A callback appending a text row to the root of `target`. */
const label = (target: Window, text: string) => (batch: NativeBatch) => {
  const node = batch.create({ kind: 'text', text })
  batch.append(target.root, node)
  return node
}

const window = (limits: Partial<Limits> = {}) => new Window({ ...DEFAULT_LIMITS, ...limits })

/** The bound of one operation without text: a removal's. */
const OPERATION_BYTES = (() => {
  const target = window()
  const mount = target.transaction()
  const node = mount.create({ kind: 'box' })
  mount.append(target.root, node)
  mount.commit(target.nodes, target.text)
  const removal = target.transaction()
  removal.remove(node)
  return removal.bytesBound()
})()

const native = (message: string) => new NativeCommandError('invalid_state', 1, message)

describe('coalesced batch groups', () => {
  test('callbacks run in order over the candidate before them and share one native batch', async () => {
    const target = window()
    let first: NativeNode<'text'> | undefined
    const outcomes = await group(target, [
      (batch) => (first = label(target, 'one')(batch)),
      (batch) => {
        // The second callback reads and changes the first one's node.
        batch.set(first!, { kind: 'text', text: 'one, edited' })
        return 'second'
      },
      label(target, 'two'),
    ])
    expect(target.sent).toHaveLength(1)
    expect(target.sent[0]!.map((operation) => operation.type)).toEqual([
      'create',
      'insert',
      'set',
      'create',
      'insert',
    ])
    expect(target.revision).toBe(1)
    expect(target.texts()).toEqual(['one, edited', 'two'])
    expect(outcomes[0]).toEqual({ index: 0, value: first })
    expect(outcomes[1]).toEqual({ index: 1, value: 'second' })
  })

  test('a throwing, asynchronous or invalid callback fails alone', async () => {
    const target = window()
    let escaped: NativeBatch | undefined
    let rejection: Promise<never> | undefined
    const outcomes = await group(target, [
      label(target, 'kept'),
      (batch) => {
        label(target, 'discarded')(batch)
        throw new Error('callback failed')
      },
      (batch) => {
        escaped = batch
        rejection = Promise.reject(new Error('late'))
        return rejection
      },
      // A created node left unattached fails validation.
      (batch) => batch.create({ kind: 'text', text: 'orphan' }),
      label(target, 'also kept'),
      () => 'no operations',
    ])
    expect((failed(outcomes[1]) as Error).message).toBe('callback failed')
    expect(failed(outcomes[2])).toBeInstanceOf(NativeStateError)
    expect((failed(outcomes[3]) as Error).message).toMatch(/attached/)
    expect(outcomes[5]).toEqual({ index: 5, value: 'no operations' })
    expect(target.sent).toHaveLength(1)
    expect(target.texts()).toEqual(['kept', 'also kept'])
    // A returned callback's transaction cannot be used later.
    expect(() => escaped!.create({ kind: 'box' })).toThrow(/already returned/)
    await expect(rejection!).rejects.toThrow('late')
  })

  test('a group never exceeds the operation limit and splits at it', async () => {
    const target = window({ max_operations: 4 })
    // Two operations each: the first two fill one batch exactly.
    await group(target, [label(target, 'a'), label(target, 'b'), label(target, 'c')])
    expect(target.sent.map((operations) => operations.length)).toEqual([4, 2])
    expect(target.revision).toBe(2)
    expect(target.texts()).toEqual(['a', 'b', 'c'])
  })

  test('a callback above the operation limit fails alone', async () => {
    const target = window({ max_operations: 4 })
    const outcomes = await group(target, [
      label(target, 'a'),
      (batch) => {
        for (const text of ['b', 'c', 'd']) label(target, text)(batch)
      },
      label(target, 'e'),
    ])
    expect((failed(outcomes[1]) as NativeStateError).code).toBe('limit_exceeded')
    expect(target.sent.map((operations) => operations.length)).toEqual([4])
    expect(target.texts()).toEqual(['a', 'e'])
  })

  test('a group splits where its frame size bound would exceed the negotiated frame', async () => {
    // Room for two single-byte text sets, by the bound.
    const target = window({ max_frame_bytes: BATCH_ENVELOPE_BYTES + 2 * (OPERATION_BYTES + 6) })
    let node: NativeNode<'text'> | undefined
    // Mount first, alone: its bound is larger than the frame.
    await group(target, [(batch) => (node = label(target, 'x')(batch))])
    const set = (text: string) => (batch: NativeBatch) => batch.set(node!, { kind: 'text', text })
    await group(target, [set('a'), set('b'), set('c')])
    expect(target.sent.map((operations) => operations.length)).toEqual([2, 2, 1])
    expect(target.texts()).toEqual(['c'])
  })

  test('a transaction that may not fit a frame is sent alone, before others build on it', async () => {
    const target = window({ max_frame_bytes: BATCH_ENVELOPE_BYTES + OPERATION_BYTES })
    target.refuse = (operations) =>
      operations.some((operation) => operation.type === 'create' && operation.node_id === 2)
        ? native('first refused')
        : undefined
    const outcomes = await group(target, [label(target, 'a'), label(target, 'b')])
    expect((failed(outcomes[0]) as Error).message).toMatch(/first refused/)
    // The second ran on the committed graph, not on the refused candidate.
    expect(outcomes[1]).toEqual({ index: 1, value: expect.anything() })
    expect(target.sent.map((operations) => operations.length)).toEqual([2, 2])
    expect(target.texts()).toEqual(['b'])
  })

  test('a request an earlier callback made is not invalidated by a later one in its batch', async () => {
    const target = window()
    let button: NativeNode<'button'> | undefined
    await group(target, [
      (batch) => {
        button = batch.create({ kind: 'button', text: 'Go' })
        batch.append(target.root, button)
      },
    ])
    const outcomes = await group(target, [
      (batch) => batch.focus(button!),
      (batch) => batch.remove(button!),
      label(target, 'after'),
    ])
    expect(outcomes.every((outcome) => 'value' in outcome)).toBe(true)
    // Focus is sent before the removal, which starts the next batch.
    expect(target.sent.slice(1).map((operations) => operations.map((item) => item.type))).toEqual([
      ['focus'],
      ['delete', 'create', 'insert'],
    ])
    expect(target.texts()).toEqual(['after'])
  })

  test('a refused merged batch is retried one transaction at a time', async () => {
    const target = window()
    let bad: NativeNode<'text'> | undefined
    target.refuse = (operations) =>
      operations.some(
        (operation) =>
          operation.type === 'create' &&
          operation.element.kind === 'text' &&
          operation.element.text === 'refused'
      )
        ? native('refused natively')
        : undefined
    const outcomes = await group(target, [
      label(target, 'first'),
      (batch) => (bad = label(target, 'refused')(batch)),
      () => 'independent',
      // Built on the refused candidate: it fails with it.
      (batch) => batch.set(bad!, { kind: 'text', text: 'built on it' }),
    ])
    expect('value' in outcomes[0]!).toBe(true)
    expect((failed(outcomes[1]) as Error).message).toMatch(/refused natively/)
    expect(outcomes[2]).toEqual({ index: 2, value: 'independent' })
    expect((failed(outcomes[3]) as NativeStateError).code).toBe('stale_revision')
    // Merged, then the first alone, then the refused one alone.
    expect(target.sent.map((operations) => operations.length)).toEqual([5, 2, 2])
    expect(target.texts()).toEqual(['first'])
    // The window stays usable.
    await group(target, [label(target, 'next')])
    expect(target.texts()).toEqual(['first', 'next'])
  })

  test('any other failure of a merged batch rejects each of its callers', async () => {
    const target = window()
    const failure = new Error('host exited')
    target.refuse = () => failure
    const outcomes = await group(target, [label(target, 'a'), () => 'kept', label(target, 'b')])
    expect(failed(outcomes[0])).toBe(failure)
    expect(outcomes[1]).toEqual({ index: 1, value: 'kept' })
    expect(failed(outcomes[2])).toBe(failure)
    expect(target.sent).toHaveLength(1)
  })

  test('a callback built on a batch that failed when the group split fails with it', async () => {
    const target = window({ max_operations: 2 })
    target.refuse = (operations) =>
      operations.some((operation) => operation.type === 'create' && operation.node_id === 2)
        ? native('refused')
        : undefined
    const outcomes = await group(target, [
      label(target, 'a'),
      label(target, 'b'),
      label(target, 'c'),
    ])
    expect((failed(outcomes[0]) as Error).message).toMatch(/refused$/)
    expect((failed(outcomes[1]) as NativeStateError).code).toBe('stale_revision')
    expect('value' in outcomes[2]!).toBe(true)
    expect(target.texts()).toEqual(['c'])
  })

  test('a closed window rejects every queued callback', async () => {
    const target = window()
    target.closed = true
    const outcomes = await group(target, [label(target, 'a'), () => 'b'])
    expect(outcomes.every((outcome) => failed(outcome) instanceof NativeStateError)).toBe(true)
    expect(target.sent).toEqual([])
  })
})

describe('frame size bound', () => {
  const styleFields: Record<string, readonly unknown[]> = {
    direction: ['column'],
    gap: [],
    padding: [],
    width: [],
    height: [],
    min_width: [],
    max_width: [],
    min_height: [],
    max_height: [],
    flex_grow: [],
    flex_shrink: [],
    align_items: ['stretch'],
    justify_content: ['space_between'],
    overflow: ['scroll'],
    scroll_anchor: ['start'],
    background: [],
    color: [],
    font_size: [],
    border_width: [],
    border_color: [],
    corner_radius: [],
    opacity: [],
    font_weight: [900],
  }
  // Long numbers first: the widest value each field accepts.
  const numbers = [-1e-300 / 3, 1e-300 / 3, 1 / 3, 16_777_215]

  function widest(base: Record<string, unknown>): Element {
    const style: Record<string, unknown> = {}
    for (const [field, choices] of Object.entries(styleFields))
      for (const value of [...choices, ...numbers]) {
        try {
          parseElement({ ...base, style: { ...style, [field]: value } })
        } catch {
          continue
        }
        style[field] = value
        break
      }
    return parseElement({ ...base, style })
  }

  test('bounds the JSON of the widest operations beyond their text', () => {
    const elements = [
      widest({
        kind: 'box',
        accessible_role: 'list_item',
        accessible_label: '',
        accessible_position: 2_147_483_647,
        accessible_selected: false,
      }),
      widest({ kind: 'box', accessible_role: 'list', accessible_set_size: 2_147_483_647 }),
      widest({ kind: 'input', value: '', placeholder: '', disabled: true, read_only: true }),
      widest({ kind: 'text', text: '', accessible_live: 'assertive' }),
      widest({ kind: 'split', ratio: 1 / 3, min_size: 1 / 3 }),
      widest({
        kind: 'overlay',
        anchor: 'parent',
        modal: false,
        surface: 'layer',
        autofocus: true,
        navigation: 'menu',
        accessible_label: '',
      }),
    ]
    expect(Object.keys(elements[0]!.style!).length).toBeGreaterThan(15)
    for (const element of elements) {
      const operation = {
        type: 'set',
        node_id: Number.MAX_SAFE_INTEGER,
        element,
        expected_input_revision: Number.MAX_SAFE_INTEGER,
      }
      expect(Buffer.byteLength(JSON.stringify(operation))).toBeLessThanOrEqual(OPERATION_BYTES)
    }
  })

  test('bounds escaped text at six bytes per UTF-8 byte', () => {
    const target = window()
    const text = '\u0001"\\é\u{1f600}'
    const transaction = target.transaction()
    transaction.append(target.root, transaction.create({ kind: 'text', text }))
    const json = Buffer.byteLength(JSON.stringify([...transaction.operations][0]))
    expect(json).toBeLessThanOrEqual(transaction.bytesBound() - OPERATION_BYTES)
    expect(transaction.bytesBound()).toBe(2 * OPERATION_BYTES + 6 * Buffer.byteLength(text))
  })
})
