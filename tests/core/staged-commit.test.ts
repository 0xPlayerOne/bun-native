import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  type NativeApplication,
  type NativeBatch,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

// The `chunked` peer negotiates eight operations per native batch and rejects
// any batch that exceeds it, leaves a node detached, reuses an identity or
// starts from a stale revision, as the native host does.
async function withApp(run: (app: NativeApplication) => Promise<void>) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'protocol-peer.ts'), 'chunked'],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics.nodes).toBe(0)
}

function rows(batch: NativeBatch, parent: NativeNode<'box'>, count: number, prefix: string) {
  const labels: NativeNode<'text'>[] = []
  for (let index = 0; index < count; index += 1) {
    const row = batch.create({ kind: 'box', style: { direction: 'row' } })
    const label = batch.create({ kind: 'text', text: `${prefix} ${index}` })
    batch.append(row, label)
    batch.append(row, batch.create({ kind: 'text', text: 'detail' }))
    batch.append(parent, row)
    labels.push(label)
  }
  return labels
}

async function clickRoutes(window: NativeWindow, label: NativeNode<'text'>, button: NativeNode) {
  const clicked = Promise.withResolvers<readonly NativeNode[]>()
  const off = window.onClick(button as NativeNode<'button'>, (event) => {
    clicked.resolve(event.path)
  })
  await window.batch((batch) => batch.set(label, { kind: 'text', text: 'emit click' }))
  const path = await clicked.promise
  off()
  return path
}

/** The strict peer's committed text order, reported through a rejected set. */
async function nativeTexts(window: NativeWindow, marker: NativeNode<'text'>) {
  const error = await window
    .batch((batch) => batch.set(marker, { kind: 'text', text: 'report texts' }))
    .then(
      () => undefined,
      (cause: Error) => cause
    )
  return error?.message.replace(/^Native invalid_state: /, '').split('|')
}

describe('logical commits above the native batch limit (headless subprocess)', () => {
  test('mount, remount and retained moves commit atomically through staged batches', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Staged' })
      const before = window.revision
      const mounted = await window.batch((batch) => {
        const pane = batch.create({ kind: 'box' })
        batch.append(window.root, pane)
        const button = batch.create({ kind: 'button', text: 'Kept' })
        batch.append(pane, button)
        return { pane, button, labels: rows(batch, pane, 12, 'Row') }
      })
      // Several native batches, one publication; every handle is committed.
      expect(window.revision - before).toBeGreaterThan(1)
      expect(app.diagnostics.nodes).toBe(1 + 2 + 12 * 3)
      expect(await clickRoutes(window, mounted.labels[11]!, mounted.button)).toEqual([
        window.root,
        mounted.pane,
        mounted.button,
      ])

      // Replace the pane while moving the retained button into a new subtree.
      const remounted = await window.batch((batch) => {
        const pane = batch.create({ kind: 'box' })
        const header = batch.create({ kind: 'box' })
        batch.append(pane, header)
        batch.append(header, mounted.button)
        const labels = rows(batch, pane, 10, 'Next')
        batch.remove(mounted.pane)
        batch.insert(window.root, pane, 0)
        batch.set(mounted.button, { kind: 'button', text: 'Moved' })
        return { pane, header, labels }
      })
      expect(app.diagnostics.nodes).toBe(1 + 2 + 1 + 10 * 3)
      expect(await clickRoutes(window, remounted.labels[0]!, mounted.button)).toEqual([
        window.root,
        remounted.pane,
        remounted.header,
        mounted.button,
      ])
      // The click marker replaced the first row's text.
      expect(await nativeTexts(window, remounted.labels[0]!)).toEqual(
        Array.from({ length: 10 }, (_, index) => [
          index ? `Next ${index}` : 'emit click',
          'detail',
        ]).flat()
      )
      await window.close()
    }))

  test('retained reorders move only the children outside the longest ordered run', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Reorder' })
      const { list, marker } = await window.batch((batch) => {
        const marker = batch.create({ kind: 'text', text: 'marker' })
        batch.append(window.root, marker)
        const list = batch.create({ kind: 'box' })
        batch.append(window.root, list)
        return { list, marker }
      })
      const labels: NativeNode<'text'>[] = []
      for (let index = 0; index < 8; index += 1)
        labels.push(
          await window.batch((batch) => {
            const label = batch.create({ kind: 'text', text: `${index}` })
            batch.append(list, label)
            return label
          })
        )
      const before = window.revision
      // A rotation plus 4 new rows: one retained move, four row inserts and
      // the staging removal fit the eight-operation final batch.
      await window.batch((batch) => {
        batch.append(list, labels[0]!)
        rows(batch, list, 4, 'New')
      })
      expect(window.revision - before).toBeGreaterThan(1)
      expect(await nativeTexts(window, marker)).toEqual([
        'marker',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '0',
        ...[0, 1, 2, 3].flatMap((index) => [`New ${index}`, 'detail']),
      ])
      await window.close()
    }))

  test('a rejected staged batch restores the committed tree and its revision', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Rollback' })
      const committed = await window.batch((batch) => {
        const label = batch.create({ kind: 'text', text: 'Committed' })
        batch.append(window.root, label)
        return label
      })
      await assert.rejects(
        window.batch((batch) => {
          rows(batch, window.root, 6, 'Staged')
          batch.append(window.root, batch.create({ kind: 'text', text: 'reject transaction' }))
        }),
        /Requested test rejection/
      )
      expect(app.diagnostics.nodes).toBe(2)
      // The strict peer accepts this only at the native revision with no
      // leftover staging nodes.
      await window.batch((batch) => batch.set(committed, { kind: 'text', text: 'Still here' }))
      const labels = await window.batch((batch) => rows(batch, window.root, 4, 'After'))
      expect(app.diagnostics.nodes).toBe(2 + 4 * 3)
      await window.batch((batch) => batch.set(labels[3]!, { kind: 'text', text: 'Updated' }))
      await window.close()
    }))

  test('new inputs keep their edit revision and committed-node changes stay in one batch', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Inputs' })
      const input = await window.batch((batch) => {
        const input = batch.create({ kind: 'input', value: '' })
        batch.append(window.root, input)
        batch.set(input, { kind: 'input', value: 'typed' }, 0)
        rows(batch, window.root, 4, 'Row')
        return input
      })
      expect(window.input(input)).toEqual({ value: 'typed', revision: 1 })
      await window.batch((batch) => batch.set(input, { kind: 'input', value: 'again' }, 1))

      const labels = await window.batch((batch) => rows(batch, window.root, 3, 'Text'))
      const revision = window.revision
      // Nine visible changes to committed nodes cannot be staged invisibly.
      await assert.rejects(
        window.batch((batch) => {
          for (const label of labels) batch.set(label, { kind: 'text', text: 'Changed' })
          for (const label of labels) batch.set(label, { kind: 'text', text: 'Twice' })
          for (const label of labels) batch.set(label, { kind: 'text', text: 'Thrice' })
        }),
        { code: 'limit_exceeded' }
      )
      expect(window.revision).toBe(revision)
      await window.close()
    }))
})
