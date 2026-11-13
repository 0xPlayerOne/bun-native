import { stableChildren } from './order.ts'
import type { Element, Limits, Operation } from '@bun-native/protocol'
import type { NodeState, Transaction } from './tree.ts'
import { NativeStateError } from './types.ts'

/**
 * A logical transaction larger than one native batch.
 *
 * The native host validates and paints each batch atomically, rejects a batch
 * above `max_operations`, and rejects any batch that leaves a node detached.
 * Splitting the application's operation sequence would therefore expose (and
 * be unable to roll back) its intermediate states. Instead, new nodes are
 * first built under a zero-size, clipped staging box appended to the window
 * root. Those staging batches touch only nodes the application has not yet
 * committed, so they change nothing it or the user can see. One final batch
 * then applies every change to committed nodes at once: sets, moves of new
 * subtrees and retained nodes into place, deletions, and the staging box's
 * removal. A failure before or in that batch removes the staging box, which
 * restores the committed tree exactly. The wire protocol is unchanged.
 *
 * New nodes receive fresh identities in pre-order so that each parent exists
 * before its children while native identities keep increasing. The
 * transaction renumbers its own copies and their handles, none of which was
 * committed, and later commits copy-on-write as a single batch does.
 */
export interface StagedCommit {
  readonly staging: readonly (readonly Operation[])[]
  readonly visible: readonly Operation[]
  readonly discard: Operation
}

const STAGING: Element = {
  kind: 'box',
  style: { width: 0, height: 0, max_width: 0, max_height: 0, flex_shrink: 0, overflow: 'hidden' },
}
// The command envelope (id, type, window and revision) and the array brackets.
const FRAME_OVERHEAD = 256

function bytes(operation: Operation): number {
  return Buffer.byteLength(JSON.stringify(operation)) + 1
}

/** Split units that must stay together into frames within both native limits. */
function frames(units: readonly Operation[][], limits: Readonly<Limits>): Operation[][] {
  const budget = limits.max_frame_bytes - FRAME_OVERHEAD
  const result: Operation[][] = []
  let current: Operation[] = []
  let size = 0
  for (const unit of units) {
    const unitSize = unit.reduce((total, operation) => total + bytes(operation), 0)
    if (
      current.length &&
      (current.length + unit.length > limits.max_operations || size + unitSize > budget)
    ) {
      result.push(current)
      current = []
      size = 0
    }
    current.push(...unit)
    size += unitSize
  }
  if (current.length) result.push(current)
  return result
}

export function planStagedCommit(
  committed: ReadonlyMap<number, NodeState>,
  transaction: Transaction,
  rootId: number,
  allocate: () => number,
  limits: Readonly<Limits>
): StagedCommit {
  const { nodes, operations } = transaction
  const preorder: number[] = []
  for (const pending = [rootId]; pending.length;) {
    const id = pending.pop()!
    preorder.push(id)
    pending.push(...[...nodes.get(id)!.children].reverse())
  }
  const staging = allocate()
  const identity = new Map<number, number>()
  for (const id of preorder) if (!committed.has(id)) identity.set(id, allocate())
  transaction.renumber(identity)
  const order = preorder.map((id) => identity.get(id) ?? id)
  const fresh = new Set(identity.values())

  const units: Operation[][] = [
    [
      { type: 'create', node_id: staging, element: STAGING },
      {
        type: 'insert',
        parent_id: rootId,
        child_id: staging,
        index: committed.get(rootId)!.children.length,
      },
    ],
  ]
  // The simulated native children after staging, for placing nodes below.
  const children = new Map<number, number[]>()
  const parents = new Map<number, number>()
  for (const [id, node] of committed) {
    children.set(id, [...node.children])
    if (node.parent !== undefined) parents.set(id, node.parent)
  }
  children.get(rootId)!.push(staging)
  children.set(staging, [])
  parents.set(staging, rootId)
  for (const next of order) {
    if (!fresh.has(next)) continue
    const node = nodes.get(next)!
    // Pre-order: a new parent is already staged; otherwise wait in the box.
    const parent = fresh.has(node.parent!) ? node.parent! : staging
    const siblings = children.get(parent)!
    units.push([
      { type: 'create', node_id: next, element: node.element },
      { type: 'insert', parent_id: parent, child_id: next, index: siblings.length },
    ])
    siblings.push(next)
    children.set(next, [])
    parents.set(next, parent)
    // A new input's edit revision counts its sets in this transaction.
    if (node.element.kind === 'input')
      for (let revision = 0; revision < node.inputRevision; revision += 1)
        units.push([
          {
            type: 'set',
            node_id: next,
            element: node.element,
            expected_input_revision: revision,
          },
        ])
  }

  const visible: Operation[] = operations.filter(
    (operation) =>
      operation.type === 'set' && committed.has(operation.node_id) && nodes.has(operation.node_id)
  )
  for (const next of order) {
    const target = nodes.get(next)!.children
    const current = children.get(next)!
    // Keep a longest already ordered run and move only the other children,
    // last first, each before its placed successor. Nodes that are not in the
    // target stay behind until they move to a later parent or are deleted.
    const stable = stableChildren(current, target)
    let anchor: number | undefined
    for (let index = target.length - 1; index >= 0; index -= 1) {
      const child = target[index]!
      if (!stable[index]) {
        const previous = children.get(parents.get(child)!)!
        previous.splice(previous.indexOf(child), 1)
        const before = anchor === undefined ? current.length : current.indexOf(anchor)
        current.splice(before, 0, child)
        parents.set(child, next)
        visible.push({ type: 'insert', parent_id: next, child_id: child, index: before })
      }
      anchor = child
    }
  }
  for (const [id, node] of committed)
    if (!nodes.has(id) && node.parent !== undefined && nodes.has(node.parent))
      visible.push({ type: 'delete', node_id: id })
  visible.push({ type: 'delete', node_id: staging })
  // Focus and scroll requests are applied natively after the tree changes, so
  // they ride the final batch, addressed by the renumbered identities.
  for (const operation of operations)
    if (
      operation.type === 'focus' ||
      operation.type === 'scroll_to' ||
      operation.type === 'scroll_into_view'
    )
      visible.push({ ...operation, node_id: identity.get(operation.node_id) ?? operation.node_id })
  if (visible.length > limits.max_operations)
    throw new NativeStateError(
      'limit_exceeded',
      'Batch operation limit exceeded by changes to committed nodes'
    )
  return {
    staging: frames(units, limits),
    visible,
    discard: { type: 'delete', node_id: staging },
  }
}

/**
 * Send a staged commit. `acknowledge` runs in each reply's own continuation,
 * so a native event after that batch never sees an older revision.
 */
export async function sendStagedCommit<Reply>(
  plan: StagedCommit,
  send: (operations: readonly Operation[]) => Promise<Reply>,
  acknowledge: (reply: Reply, final: boolean) => void
): Promise<void> {
  let staged = false
  try {
    for (const operations of plan.staging) {
      acknowledge(await send(operations), false)
      staged = true
    }
    acknowledge(await send(plan.visible), true)
  } catch (error) {
    // Removing the box (and every new node still in it) restores the
    // committed tree; the original rejection is the transaction's result.
    if (staged)
      try {
        acknowledge(await send([plan.discard]), false)
      } catch {
        // A closed window or failed host already ended this tree's lifetime.
      }
    throw error
  }
}
