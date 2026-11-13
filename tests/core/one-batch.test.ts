// Protocol 12 sends one transaction as one native batch. A transaction above
// the negotiated operation or frame limit is rejected before it is sent and
// leaves the window, its revision and the session usable.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createApplication, NativeStateError, type NativeApplication } from '@bun-native/core'
import { MAX_FRAME_BYTES, MAX_TEXT_BYTES, ProtocolError } from '@bun-native/protocol'

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
  expect(app.diagnostics.nodes).toBe(0)
}

test('appending 1,000 children to the committed root is one batch', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Root append' })
    const revision = window.revision
    await window.batch((batch) => {
      for (let index = 0; index < 1_000; index += 1)
        batch.append(window.root, batch.create({ kind: 'text', text: `Row ${index}` }))
    })
    expect(window.revision - revision).toBe(1)
    expect(app.diagnostics.nodes).toBe(1_001)
    await window.close()
  }))

test('a full window mounts in one batch', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Full window' })
    const revision = window.revision
    await window.batch((batch) => {
      const pane = batch.create({ kind: 'box' })
      batch.append(window.root, pane)
      for (let index = 2; index < app.limits.max_nodes_per_window; index += 1)
        batch.append(pane, batch.create({ kind: 'text', text: `${index}` }))
    })
    expect(window.revision - revision).toBe(1)
    expect(app.diagnostics.nodes).toBe(app.limits.max_nodes_per_window)
    await window.close()
  }))

test('a transaction above the operation limit is rejected before it is sent', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Operation limit' })
    const label = await window.batch((batch) => {
      const label = batch.create({ kind: 'text', text: 'Label' })
      batch.append(window.root, label)
      return label
    })
    const revision = window.revision
    let sets = 0
    await assert.rejects(
      window.batch((batch) => {
        for (;;) {
          batch.set(label, { kind: 'text', text: `${sets}` })
          sets += 1
        }
      }),
      (error: unknown) =>
        error instanceof NativeStateError &&
        error.code === 'limit_exceeded' &&
        error.message === 'Batch operation limit exceeded'
    )
    expect(sets).toBe(app.limits.max_operations)
    expect(window.revision).toBe(revision)
    await window.batch((batch) => batch.set(label, { kind: 'text', text: 'Still usable' }))
    expect(window.revision).toBe(revision + 1)
    await window.close()
  }))

test('a transaction above the frame limit is rejected before it is written', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Frame limit' })
    const label = await window.batch((batch) => {
      const label = batch.create({ kind: 'text', text: 'Label' })
      batch.append(window.root, label)
      return label
    })
    const revision = window.revision
    // Each set is within the text limit, and the last one leaves the window's
    // text within its budget, but together they exceed one frame.
    const text = 'x'.repeat(MAX_TEXT_BYTES)
    const sets = Math.ceil(MAX_FRAME_BYTES / MAX_TEXT_BYTES) + 1
    await assert.rejects(
      window.batch((batch) => {
        for (let index = 0; index < sets; index += 1) batch.set(label, { kind: 'text', text })
      }),
      (error: unknown) => error instanceof ProtocolError && /frame|byte limit/i.test(error.message)
    )
    expect(window.revision).toBe(revision)
    await window.batch((batch) => batch.set(label, { kind: 'text', text: 'Still usable' }))
    expect(window.revision).toBe(revision + 1)
    await window.close()
  }))
