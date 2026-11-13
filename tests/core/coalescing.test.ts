// Batches queued for one window behind the transaction in flight share native
// batches; anything queued between them keeps them apart. Headless peer.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  createApplication,
  NativeCommandError,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'

async function withApp(run: (app: NativeApplication) => Promise<void>) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'protocol-peer.ts')],
    requestTimeoutMs: 5_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics.queuedTransactions).toBe(0)
  expect(app.diagnostics.nodes).toBe(0)
}

async function labelled(window: NativeWindow): Promise<NativeNode<'text'>> {
  return window.batch((batch) => {
    const label = batch.create({ kind: 'text', text: 'Label' })
    batch.append(window.root, label)
    return label
  })
}

test('batches queued behind one in flight share one native batch and settle in order', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Coalesced' })
    const label = await labelled(window)
    const revision = window.revision
    const order: string[] = []
    const queued: Promise<unknown>[] = []
    let row: NativeNode<'text'> | undefined
    await window.batch((batch) => {
      batch.set(label, { kind: 'text', text: 'In flight' })
      // Queued while this transaction is built and sent.
      queued.push(
        window.batch((next) => {
          row = next.create({ kind: 'text', text: 'Row' })
          next.append(window.root, row)
          order.push('row')
          return 'created'
        }),
        window.batch((next) => {
          // Reads the previous callback's uncommitted node.
          next.set(row!, { kind: 'text', text: 'Row, edited' })
          order.push('edit')
        }),
        window.batch(() => {
          order.push('read')
          return 'nothing to send'
        })
      )
      expect(app.diagnostics.queuedTransactions).toBe(4)
    })
    expect(await Promise.all(queued)).toEqual(['created', undefined, 'nothing to send'])
    expect(order).toEqual(['row', 'edit', 'read'])
    expect(window.revision).toBe(revision + 2)
    expect(app.diagnostics.nodes).toBe(3)
    await window.close()
  }))

test('an operation queued between two batches keeps them in separate native batches', () =>
  withApp(async (app) => {
    const one = await app.openWindow({ title: 'One' })
    const two = await app.openWindow({ title: 'Two' })
    const [first, second] = [await labelled(one), await labelled(two)]
    const revisions = [one.revision, two.revision]
    const queued: Promise<unknown>[] = []
    await one.batch((batch) => {
      batch.set(first, { kind: 'text', text: 'Start' })
      queued.push(
        one.batch((next) => next.set(first, { kind: 'text', text: 'A' })),
        two.batch((next) => next.set(second, { kind: 'text', text: 'Other window' })),
        one.batch((next) => next.set(first, { kind: 'text', text: 'B' })),
        app.openWindow({ title: 'Three' }).then((three) => three.close()),
        one.batch((next) => next.set(first, { kind: 'text', text: 'C' })),
        one.batch((next) => next.set(first, { kind: 'text', text: 'D' }))
      )
    })
    await Promise.all(queued)
    // Start, A, B, then C and D together.
    expect(one.revision).toBe(revisions[0]! + 4)
    expect(two.revision).toBe(revisions[1]! + 1)
    await one.close()
    await two.close()
  }))

test('a natively rejected merged batch rejects only the transaction the host refused', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Rejection' })
    const label = await labelled(window)
    const revision = window.revision
    const queued: Promise<unknown>[] = []
    await window.batch((batch) => {
      batch.set(label, { kind: 'text', text: 'Start' })
      queued.push(
        window.batch((next) => next.set(label, { kind: 'text', text: 'Kept' })),
        window.batch((next) => {
          // The peer refuses any batch that creates this text.
          next.append(window.root, next.create({ kind: 'text', text: 'reject transaction' }))
        }),
        window.batch(() => 'independent')
      )
    })
    const [kept, refused, independent] = await Promise.allSettled(queued)
    expect(kept).toEqual({ status: 'fulfilled', value: undefined })
    assert(refused?.status === 'rejected')
    expect(refused.reason).toBeInstanceOf(NativeCommandError)
    expect(independent).toEqual({ status: 'fulfilled', value: 'independent' })
    // Start, then Kept once retried alone.
    expect(window.revision).toBe(revision + 2)
    expect(app.diagnostics.nodes).toBe(2)
    await window.close()
  }))
