import { expect, test } from 'bun:test'
import type { Limits } from '@bun-native/protocol'
import { planStagedCommit } from '../../packages/core/src/commit-plan.ts'
import { CommittedText, makeNode, Transaction } from '../../packages/core/src/tree.ts'
import type { NativeNode } from '../../packages/core/src/types.ts'

const limits = {
  max_operations: 8,
  max_nodes_per_window: 64,
  max_depth: 4,
  max_text_bytes: 64,
  max_text_bytes_per_window: 1024,
} as Readonly<Limits>

test('focus and scroll requests survive a staged commit with renumbered identities', () => {
  let next = 1
  const root = makeNode(next++, { kind: 'box' })
  const committed = new Map([[root.id, root]])
  const text = new CommittedText(limits.max_text_bytes_per_window, committed.values())
  const transaction = new Transaction(
    committed,
    root.id,
    () => next++,
    limits,
    ['focus_v1', 'scroll_control_v1'],
    text
  )
  const list = transaction.create({ kind: 'box', style: { overflow: 'scroll_y' } })
  transaction.append(root.handle as NativeNode<'box'>, list)
  const button = transaction.create({ kind: 'button', text: 'Go' })
  transaction.append(list, button)
  for (let index = 0; index < 6; index += 1)
    transaction.append(list, transaction.create({ kind: 'text', text: `row ${index}` }))
  transaction.focus(button)
  transaction.scrollTo(list, { y: 40 })
  transaction.scrollIntoView(button)
  transaction.validate()
  transaction.finish()
  expect(transaction.operations.length).toBeGreaterThan(limits.max_operations)

  const plan = planStagedCommit(committed, transaction, root.id, () => next++, limits)
  const created = plan.staging
    .flat()
    .flatMap((operation) => (operation.type === 'create' ? [operation.node_id] : []))
  const requests = plan.visible.filter(
    (operation) =>
      operation.type === 'focus' ||
      operation.type === 'scroll_to' ||
      operation.type === 'scroll_into_view'
  )
  expect(requests.map((operation) => operation.type)).toEqual([
    'focus',
    'scroll_to',
    'scroll_into_view',
  ])
  // Every request addresses a node the staging batches created, not a stale id.
  for (const request of requests) expect(created).toContain(request.node_id)
})
