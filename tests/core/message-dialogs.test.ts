import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  type MessageDialogOptions,
  type MessageDialogResult,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

const FULL = ['--overlays', '--keyboard']

async function withApp(run: (app: NativeApplication) => Promise<void>, flags = FULL) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'overlay-peer.ts'), ...flags],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics).toMatchObject({ windows: 0, nodes: 0, callbacks: 0, activeCallbacks: 0 })
}

async function waitFor(check: () => boolean, description: string) {
  const until = performance.now() + 2_000
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(1)
  }
}

type Fixture = {
  window: NativeWindow
  /** Routed events the application's root capture listeners observed. */
  observed: string[]
  /** Ask the peer to emit routed events after this batch's acknowledgement. */
  send(events: unknown[]): Promise<void>
}

async function fixture(app: NativeApplication): Promise<Fixture> {
  const window = await app.openWindow({ title: 'Message dialogs' })
  const trigger = await window.batch((batch) => {
    const node = batch.create({ kind: 'text', text: '' })
    batch.append(window.root, node)
    return node
  })
  const observed: string[] = []
  for (const type of ['click', 'key_down', 'pointer_down', 'focus'] as const)
    window.on(window.root, type, (event) => void observed.push(event.type), { capture: true })
  return {
    window,
    observed,
    send: (events) =>
      window.batch((batch) =>
        batch.set(trigger, { kind: 'text', text: 'event:' + JSON.stringify(events) })
      ),
  }
}

const SAVE: MessageDialogOptions = {
  title: 'Unsaved changes',
  message: 'Save the document before closing?',
  detail: 'Your changes are lost if you do not save.\nThis cannot be undone.',
  buttons: [
    { id: 'save', label: 'Save', kind: 'primary' },
    { id: 'discard', label: 'Discard', kind: 'destructive' },
    { id: 'cancel', label: 'Cancel' },
  ],
  cancelButton: 'cancel',
}

/** Show a dialog and wait until its layer has been acknowledged. */
async function open(
  window: NativeWindow,
  options: MessageDialogOptions = SAVE,
  request: { signal?: AbortSignal } = {}
) {
  const before = window.revision
  const result = window.showMessageDialog(options, request)
  void result.catch(() => {})
  await waitFor(() => window.revision > before, 'the dialog layer commit')
  // Boxed: returning the promise itself would await the dialog's result.
  return { result }
}

const settled = async (promise: Promise<unknown>) => {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true)
  )
  await Bun.sleep(30)
  return done
}

const serviceError = (code: string) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === 'message_dialogs' && error.code === code

describe('message dialogs on the modal overlay (headless subprocess)', () => {
  test('the capability needs overlays and focus requests; otherwise nothing is sent', async () => {
    for (const flags of [[], ['--overlays'], ['--keyboard']])
      await withApp(async (app) => {
        expect(app.serviceCapabilities.messageDialogs).toEqual({
          availability: 'unavailable',
          reason: 'unsupported_host',
        })
        const window = await app.openWindow({ title: 'No dialogs' })
        await assert.rejects(window.showMessageDialog(SAVE), serviceError('service_unavailable'))
        await assert.rejects(
          window.showConfirmDialog({ title: 'Delete', message: 'Sure?' }),
          serviceError('service_unavailable')
        )
        expect(window.revision).toBe(0)
      }, flags)
    await withApp(async (app) => {
      expect(app.serviceCapabilities.messageDialogs).toEqual({
        availability: 'available',
        scope: 'owned_window',
        backend: 'modal_overlay',
      })
      expect(Object.isFrozen(app.serviceCapabilities.messageDialogs)).toBe(true)
    })
  })

  test('options are validated strictly and bounded before anything is staged', () =>
    withApp(async (app) => {
      const { window, send } = await fixture(app)
      const revision = window.revision
      const button = { id: 'ok', label: 'OK' }
      const invalid: unknown[] = [
        undefined,
        null,
        [],
        { ...SAVE, extra: true },
        { ...SAVE, title: '' },
        { ...SAVE, title: '   ' },
        { ...SAVE, title: 'two\nlines' },
        { ...SAVE, title: 'x'.repeat(257) },
        { ...SAVE, title: 'é'.repeat(129) },
        { ...SAVE, title: 7 },
        { ...SAVE, message: '' },
        { ...SAVE, message: 'tab\there' },
        { ...SAVE, message: 'nul\0' },
        { ...SAVE, message: '\ud800' },
        { ...SAVE, message: 'x'.repeat(2_049) },
        { ...SAVE, detail: '' },
        { ...SAVE, detail: 'x'.repeat(4_097) },
        { ...SAVE, buttons: [] },
        { ...SAVE, buttons: 'ok' },
        { ...SAVE, buttons: [button, button] },
        { ...SAVE, buttons: Array.from({ length: 5 }, (_, i) => ({ id: 'b' + i, label: 'B' })) },
        { ...SAVE, buttons: [{ id: 'ok' }] },
        { ...SAVE, buttons: [{ ...button, label: 'a\nb' }] },
        { ...SAVE, buttons: [{ ...button, label: 'x'.repeat(65) }] },
        { ...SAVE, buttons: [{ ...button, id: '' }] },
        { ...SAVE, buttons: [{ ...button, id: 'x'.repeat(65) }] },
        { ...SAVE, buttons: [{ ...button, kind: 'link' }] },
        { ...SAVE, buttons: [{ ...button, extra: 1 }] },
        { ...SAVE, buttons: [null] },
        { ...SAVE, defaultButton: 'missing' },
        { ...SAVE, cancelButton: 'missing' },
        { ...SAVE, dismissible: 'yes' },
      ]
      for (const options of invalid)
        await assert.rejects(
          window.showMessageDialog(options as MessageDialogOptions),
          TypeError,
          JSON.stringify(options)
        )
      for (const options of [
        { title: 'T', message: 'M', extra: 1 },
        { title: 'T', message: 'M', destructive: 1 },
        { title: 'T', message: 'M', confirmLabel: '' },
        { title: '', message: 'M' },
      ])
        await assert.rejects(window.showConfirmDialog(options as never), TypeError)
      await assert.rejects(
        window.showMessageDialog(SAVE, { timeout: 1 } as never),
        TypeError,
        'request options'
      )
      expect(window.revision).toBe(revision)
      // Exact bounds are accepted; the caller's later mutation changes nothing.
      const options = {
        title: 'x'.repeat(256),
        message: 'x'.repeat(2_048),
        detail: 'x'.repeat(4_096),
        buttons: [1, 2, 3, 4].map((i) => ({ id: 'x'.repeat(63) + i, label: 'y'.repeat(64) })),
      }
      const result = (await open(window, options)).result
      options.buttons[0]!.id = 'mutated'
      await send([{ type: 'activate' }])
      expect(await result).toEqual({ kind: 'button', id: 'x'.repeat(63) + '1' })
    }))

  test('a click resolves its button id after the layer is removed; input stays inside', () =>
    withApp(async (app) => {
      const { window, observed, send } = await fixture(app)
      const before = window.revision
      const nodes = app.diagnostics.nodes
      const result = (await open(window)).result
      // Layer, frame, panel, title, message, detail, button row and three buttons.
      expect(app.diagnostics.nodes).toBe(nodes + 10)
      await send([
        { type: 'pointer_down', target: 'overlay#0' },
        { type: 'click', target: 'Discard' },
      ])
      const value: MessageDialogResult = await result
      expect(value).toEqual({ kind: 'button', id: 'discard' })
      expect(Object.isFrozen(value)).toBe(true)
      // The result arrives only after the removal committed.
      expect(app.diagnostics.nodes).toBe(nodes)
      expect(window.revision).toBe(before + 3)
      // The focus move, backdrop press and click were handled by the dialog only.
      expect(observed).toEqual([])
    }))

  test('Enter activates the focused default button; destructive confirmations focus Cancel', () =>
    withApp(async (app) => {
      const { window, send } = await fixture(app)
      let result = (await open(window, { ...SAVE, defaultButton: 'discard' })).result
      await send([{ type: 'activate' }])
      expect(await result).toEqual({ kind: 'button', id: 'discard' })
      result = (await open(window)).result
      await send([{ type: 'activate' }])
      expect(await result).toEqual({ kind: 'button', id: 'save' })

      const confirm = (options: Parameters<NativeWindow['showConfirmDialog']>[0]) => {
        const before = window.revision
        const answer = window.showConfirmDialog(options)
        return { answer, opened: waitFor(() => window.revision > before, 'confirm layer') }
      }
      let pending = confirm({ title: 'Continue', message: 'Apply the change?' })
      await pending.opened
      await send([{ type: 'activate' }])
      expect(await pending.answer).toBe(true)
      pending = confirm({
        title: 'Delete',
        message: 'Delete the file?',
        confirmLabel: 'Delete',
        cancelLabel: 'Keep',
        destructive: true,
      })
      await pending.opened
      await send([{ type: 'activate' }])
      expect(await pending.answer).toBe(false)
      pending = confirm({ title: 'Delete', message: 'Delete?', confirmLabel: 'Delete' })
      await pending.opened
      await send([{ type: 'click', target: 'Delete' }])
      expect(await pending.answer).toBe(true)
    }))

  test('Escape activates the cancel button; backdrop and Escape dismiss only when allowed', () =>
    withApp(async (app) => {
      const { window, send } = await fixture(app)
      let result = (await open(window)).result
      // A modified Escape and a backdrop press on a non-dismissible dialog are ignored.
      await send([
        { type: 'key_down', target: 'Save', control: true },
        { type: 'pointer_down', target: 'overlay#0' },
      ])
      expect(await settled(result)).toBe(false)
      await send([{ type: 'key_down', target: 'Save' }])
      expect(await result).toEqual({ kind: 'button', id: 'cancel' })

      const { cancelButton: _, ...plain } = SAVE
      result = (await open(window, plain)).result
      await send([
        { type: 'key_down', target: 'Save' },
        { type: 'pointer_down', target: 'overlay#0' },
      ])
      expect(await settled(result)).toBe(false)
      await send([{ type: 'click', target: 'Save' }])
      expect(await result).toEqual({ kind: 'button', id: 'save' })

      result = (await open(window, { ...plain, dismissible: true })).result
      await send([{ type: 'key_down', target: 'overlay#0' }])
      expect(await result).toEqual({ kind: 'dismissed' })
      result = (await open(window, { ...plain, dismissible: true })).result
      // A press on a descendant is not a backdrop press.
      await send([{ type: 'pointer_down', target: 'Save' }])
      expect(await settled(result)).toBe(false)
      await send([{ type: 'pointer_down', target: 'overlay#0' }])
      expect(await result).toEqual({ kind: 'dismissed' })
      // With a cancel button, Escape on a dismissible dialog still names it.
      result = (await open(window, { ...SAVE, dismissible: true })).result
      await send([
        { type: 'key_down', target: 'Save' },
        { type: 'click', target: 'Save' },
      ])
      expect(await result).toEqual({ kind: 'button', id: 'cancel' })
    }))

  test('dialogs are queued per window and shown one at a time in call order', () =>
    withApp(async (app) => {
      const { window, send } = await fixture(app)
      const other = await app.openWindow({ title: 'Independent' })
      const nodes = app.diagnostics.nodes
      const first = (await open(window, { ...SAVE, title: 'First' })).result
      const second = window.showMessageDialog({ ...SAVE, title: 'Second' })
      const third = window.showConfirmDialog({ title: 'Third', message: 'Third?' })
      // Another window's dialog is independent of this queue.
      const elsewhere = (await open(other, { ...SAVE, title: 'Elsewhere' })).result
      await Bun.sleep(20)
      expect(app.diagnostics.nodes).toBe(nodes + 20)
      const order: string[] = []
      void second.then(
        () => order.push('second'),
        () => {}
      )
      void third.then(
        () => order.push('third'),
        () => {}
      )
      await send([{ type: 'click', target: 'Save' }])
      expect(await first).toEqual({ kind: 'button', id: 'save' })
      // The next dialog opens only after the previous layer was removed.
      await waitFor(() => app.diagnostics.nodes === nodes + 20, 'the second dialog')
      await send([{ type: 'click', target: 'Discard' }])
      expect(await second).toEqual({ kind: 'button', id: 'discard' })
      await waitFor(() => app.diagnostics.nodes === nodes + 10 + 8, 'the third dialog')
      await send([{ type: 'key_down', target: 'OK' }])
      expect(await third).toBe(false)
      expect(order).toEqual(['second', 'third'])
      await other.close()
      await assert.rejects(elsewhere, NativeStateError)

      // At most eight per window, the shown one included.
      const held = Array.from({ length: 8 }, (_, i) =>
        window.showMessageDialog({ ...SAVE, title: 'Held ' + i })
      )
      for (const entry of held) void entry.catch(() => {})
      await assert.rejects(window.showMessageDialog(SAVE), serviceError('limit_exceeded'))
      await window.close()
      for (const entry of held)
        await assert.rejects(entry, (error: unknown) => {
          return error instanceof NativeStateError && error.code === 'invalid_handle'
        })
    }))

  test('a listener awaiting a dialog does not block the dialog input', () =>
    withApp(async (app) => {
      const { window, send } = await fixture(app)
      const opener = await window.batch((batch) => {
        const node = batch.create({ kind: 'button', text: 'Delete file' })
        batch.append(window.root, node)
        return node
      })
      const answers: boolean[] = []
      window.onClick(opener, async () => {
        answers.push(await window.showConfirmDialog({ title: 'Delete', message: 'Delete it?' }))
      })
      const before = window.revision
      await send([{ type: 'click', target: 'Delete file' }])
      await waitFor(() => window.revision > before + 1, 'the dialog opened by a listener')
      await send([{ type: 'click', target: 'OK' }])
      await waitFor(() => answers.length === 1, 'the awaiting listener')
      expect(answers).toEqual([true])
      expect(app.diagnostics.activeCallbacks).toBe(0)
    }))

  test('an abort signal cancels a queued, opening or shown dialog and removes its layer', () =>
    withApp(async (app) => {
      const { window, send } = await fixture(app)
      const nodes = app.diagnostics.nodes
      const aborted = AbortSignal.abort()
      const revision = window.revision
      await assert.rejects(
        window.showMessageDialog(SAVE, { signal: aborted }),
        serviceError('cancelled')
      )
      expect(window.revision).toBe(revision)

      const shownAbort = new AbortController()
      const queuedAbort = new AbortController()
      const first = (await open(window, SAVE, { signal: shownAbort.signal })).result
      const queued = window.showMessageDialog(
        { ...SAVE, title: 'Queued' },
        {
          signal: queuedAbort.signal,
        }
      )
      const last = window.showMessageDialog({ ...SAVE, title: 'Last' })
      queuedAbort.abort()
      await assert.rejects(queued, serviceError('cancelled'))
      shownAbort.abort()
      await assert.rejects(first, serviceError('cancelled'))
      // The aborted queued dialog was never shown; the last one is next.
      await waitFor(() => app.diagnostics.nodes === nodes + 10, 'the last dialog')
      // An abort after settlement changes nothing.
      await send([{ type: 'click', target: 'Cancel' }])
      expect(await last).toEqual({ kind: 'button', id: 'cancel' })

      // An abort while the layer batch is in flight removes it once committed.
      const opening = new AbortController()
      const result = window.showMessageDialog(SAVE, { signal: opening.signal })
      opening.abort()
      await assert.rejects(result, serviceError('cancelled'))
      expect(app.diagnostics.nodes).toBe(nodes)
    }))

  test('owner close and shutdown reject every dialog deterministically', async () => {
    await withApp(async (app) => {
      const { window } = await fixture(app)
      const visible = (await open(window)).result
      const queued = window.showMessageDialog(SAVE)
      void queued.catch(() => {})
      await window.close()
      for (const entry of [visible, queued])
        await assert.rejects(
          entry,
          (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
        )
      await assert.rejects(
        window.showMessageDialog(SAVE),
        (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
      )
    })
    await withApp(async (app) => {
      const { window } = await fixture(app)
      const visible = (await open(window)).result
      const queued = window.showConfirmDialog({ title: 'Queued', message: 'Queued?' })
      void queued.catch(() => {})
      await app.shutdown()
      for (const entry of [visible, queued])
        await assert.rejects(
          entry,
          (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
        )
    })
  })

  test('a dialog that cannot take focus under a deeper application modal fails cleanly', () =>
    withApp(async (app) => {
      const { window, send } = await fixture(app)
      const nodes = app.diagnostics.nodes
      const inner = await window.batch((batch) => {
        let parent: NativeNode<'box' | 'overlay'> = window.root
        for (let depth = 0; depth < 2; depth++) {
          const overlay = batch.create({ kind: 'overlay', modal: true })
          batch.append(parent, overlay)
          parent = overlay
        }
        return parent
      })
      const failing = window.showMessageDialog(SAVE)
      const next = window.showMessageDialog(SAVE)
      void next.catch(() => {})
      await assert.rejects(
        failing,
        (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_state'
      )
      expect(app.diagnostics.nodes).toBe(nodes + 2)
      // The queue moves on: once the application modal is gone the next one opens.
      await assert.rejects(next, NativeStateError)
      await window.batch((batch) => batch.remove(inner))
      const result = (await open(window)).result
      await send([{ type: 'activate' }])
      expect(await result).toEqual({ kind: 'button', id: 'save' })
    }))
})
