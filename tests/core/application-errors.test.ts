import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeCommandError,
  NativeServiceError,
  NativeStateError,
  ProtocolError,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
  type NotificationEvent,
  type ServicePermissions,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PeerScript } from './scripted-peer.ts'

const ALLOW: ServicePermissions = {
  windowDisplay: 'allow',
  clipboardRead: 'allow',
  clipboardWrite: 'allow',
  globalShortcuts: 'allow',
  notifications: 'allow',
}
const SHORTCUT = { key: 'k', control: true } as const
const CONTENT = { title: 'Scripted', body: 'Headless' } as const

type Control = { script(value: PeerScript): void }

async function withScripted(
  run: (app: NativeApplication, control: Control) => Promise<void>,
  mode: 'normal' | 'small' = 'normal'
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-scripted-peer-'))
  const control: Control = {
    script: (value) => writeFileSync(join(directory, 'script.json'), JSON.stringify(value)),
  }
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, 'scripted-peer.ts'), directory, mode],
      permissions: ALLOW,
      requestTimeoutMs: 2_000,
    })
    await run(app, control)
  } finally {
    await app?.shutdown().catch(() => {})
    await app?.closed.catch(() => {})
    if (app) expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
    rmSync(directory, { recursive: true, force: true })
  }
}

async function text(window: NativeWindow) {
  return window.batch((batch) => {
    const label = batch.create({ kind: 'text', text: 'Label' })
    batch.append(window.root, label)
    return label
  })
}

/** The session still accepts and completes new native work. */
async function healthy(app: NativeApplication) {
  const window = await app.openWindow({ title: 'Still healthy' })
  await window.close()
}

async function until(condition: () => boolean) {
  const deadline = performance.now() + 1_000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Scripted peer state did not settle')
    await Bun.sleep(1)
  }
}

describe('application error paths (scripted headless subprocess)', () => {
  test('rejects listeners and edit-state reads on the wrong element kind', () =>
    withScripted(async (app) => {
      const window = await app.openWindow({ title: 'Wrong kinds' })
      const label = await text(window)
      assert.throws(
        () => window.onClick(label as unknown as NativeNode<'button'>, () => {}),
        (error: unknown) =>
          error instanceof NativeStateError &&
          error.code === 'invalid_state' &&
          /require a button/.test(error.message)
      )
      assert.throws(
        () => window.onInput(label as unknown as NativeNode<'input'>, () => {}),
        /require an input/
      )
      assert.throws(
        () => window.input(label as unknown as NativeNode<'input'>),
        /Only an input has an edit state/
      )
      expect(app.diagnostics.callbacks).toBe(0)
      await assert.rejects(window.displaySnapshot(null as never), TypeError)
      await assert.rejects(window.displaySnapshot([] as never), TypeError)
    }))

  test('enforces negotiated operation and depth limits and tree shape before IPC', () =>
    withScripted(async (app) => {
      const window = await app.openWindow({ title: 'Tree limits' })
      await assert.rejects(
        window.batch((batch) => {
          let parent = window.root
          for (let depth = 0; depth < 3; depth += 1) {
            const child = batch.create({ kind: 'box' })
            batch.append(parent, child)
            parent = child
          }
        }),
        /Native tree depth limit exceeded/
      )
      const label = await text(window)
      await assert.rejects(
        window.batch((batch) =>
          batch.set(
            label as unknown as NativeNode<'input'>,
            { kind: 'text', text: 'x' } as never,
            0
          )
        ),
        /Only an input accepts an edit revision/
      )
      await assert.rejects(
        window.batch((batch) =>
          batch.append(label as unknown as NativeNode<'box'>, batch.create({ kind: 'box' }))
        ),
        /Only boxes, splits and overlays accept children and the root cannot move/
      )
      await assert.rejects(
        window.batch((batch) => {
          const box = batch.create({ kind: 'box' })
          batch.append(window.root, box)
          batch.append(box, window.root)
        }),
        /root cannot move/
      )
      expect(window.revision).toBe(1)
      expect(app.diagnostics.nodes).toBe(2)
    }, 'small'))

  test('stages new subtrees above the operation limit but rejects committed changes above it', () =>
    withScripted(async (app) => {
      const window = await app.openWindow({ title: 'Staged limits' })
      // New subtrees above the limit commit in staged batches (#488) ...
      const staged = await window.batch((batch) => {
        const box = batch.create({ kind: 'box' })
        for (let index = 0; index < 9; index += 1) batch.append(box, batch.create({ kind: 'box' }))
        batch.append(window.root, box)
        return box
      })
      await window.batch((batch) => batch.remove(staged))
      // ... but visible changes to committed nodes above it cannot be staged.
      const committed = await text(window)
      const revision = window.revision
      await assert.rejects(
        window.batch((batch) => {
          for (let index = 0; index < 9; index += 1)
            batch.set(committed, { kind: 'text', text: `Changed ${index}` })
        }),
        (error: unknown) =>
          error instanceof NativeStateError &&
          error.code === 'limit_exceeded' &&
          error.message === 'Batch operation limit exceeded by changes to committed nodes'
      )
      expect(window.revision).toBe(revision)
      await window.batch((batch) => batch.remove(committed))
      expect(app.diagnostics.nodes).toBe(1)
    }, 'small'))

  test('reports an exhausted input revision instead of wrapping it', () =>
    withScripted(async (app, control) => {
      const window = await app.openWindow({ title: 'Input revision exhaustion' })
      control.script({
        batch: {
          after: [
            {
              type: 'input',
              sequence: '$sequence',
              window_id: '$window',
              $route: 'input',
              value: 'native',
              input_revision: Number.MAX_SAFE_INTEGER,
            },
          ],
        },
      })
      const input = await window.batch((batch) => {
        const node = batch.create({ kind: 'input', value: '' })
        batch.append(window.root, node)
        return node
      })
      control.script({})
      await until(() => window.input(input).revision === Number.MAX_SAFE_INTEGER)
      await assert.rejects(
        window.batch((batch) =>
          batch.set(input, { kind: 'input', value: 'next' }, Number.MAX_SAFE_INTEGER)
        ),
        (error: unknown) =>
          error instanceof NativeStateError &&
          error.code === 'limit_exceeded' &&
          error.message === 'Input revision exhausted'
      )
      expect(window.input(input)).toEqual({ value: 'native', revision: Number.MAX_SAFE_INTEGER })
    }))

  test('revokes a window whose native open is rejected', () =>
    withScripted(async (app, control) => {
      control.script({ open: { error: 'native_failure' } })
      await assert.rejects(
        app.openWindow({ title: 'Rejected open' }),
        (error: unknown) => error instanceof NativeCommandError && error.code === 'native_failure'
      )
      expect(app.diagnostics.windows).toBe(0)
      expect(app.diagnostics.nodes).toBe(0)
      control.script({})
      const window = await app.openWindow({ title: 'Accepted open' })
      expect(app.diagnostics.windows).toBe(1)
      await window.close()
    }))

  test('cancels queued transactions and service requests when shutdown starts', () =>
    withScripted(async (app) => {
      const window = await app.openWindow({ title: 'Queued work' })
      const batch = window.batch((tree) => tree.create({ kind: 'box' }))
      const read = window.readClipboardText()
      const stopping = app.shutdown()
      await assert.rejects(batch, /Transaction cancelled during shutdown/)
      await assert.rejects(
        read,
        (error: unknown) =>
          error instanceof NativeStateError &&
          /Service request cancelled during shutdown/.test(error.message)
      )
      await stopping
      await app.closed
    }))

  test('reports exhausted identity spaces as limit errors without reusing identities', () =>
    withScripted(async (app) => {
      const window = await app.openWindow({ title: 'Identity exhaustion' })
      // These counters cannot be exhausted in a test lifetime; set their
      // private state directly to exercise the explicit no-wraparound contract.
      const ids = (app as unknown as { ids: Record<string, { next: number }> }).ids
      const exhausted = Number.MAX_SAFE_INTEGER + 1
      const limit = (message: string) => (error: unknown) =>
        error instanceof NativeStateError &&
        error.code === 'limit_exceeded' &&
        error.message === message
      ids['shortcut']!.next = exhausted
      await assert.rejects(
        window.registerGlobalShortcut(SHORTCUT, () => {}),
        limit('Global shortcut identity space exhausted')
      )
      ids['notification']!.next = exhausted
      await assert.rejects(
        window.postNotification(CONTENT, () => {}),
        limit('Notification identity space exhausted')
      )
      ids['node']!.next = exhausted
      await assert.rejects(
        window.batch((batch) => batch.create({ kind: 'box' })),
        limit('Native node identity space exhausted')
      )
      ids['window']!.next = exhausted
      await assert.rejects(
        app.openWindow({ title: 'Exhausted' }),
        limit('Native window identity space exhausted')
      )
      expect(app.diagnostics.windows).toBe(1)
      expect(app.diagnostics.serviceRequests).toBe(0)
    }))

  test('preserves native command errors outside each service vocabulary', () =>
    withScripted(async (app, control) => {
      const window = await app.openWindow({ title: 'Service errors' })
      const command = (error: unknown) =>
        error instanceof NativeCommandError &&
        !(error instanceof NativeServiceError) &&
        error.code === 'invalid_state'
      control.script({
        display_snapshot: { error: 'invalid_state' },
        clipboard_read: { error: 'invalid_state' },
        register_global_shortcut: { error: 'invalid_state' },
        post_notification: { error: 'invalid_state' },
      })
      await assert.rejects(window.displaySnapshot(), command)
      await assert.rejects(window.readClipboardText(), command)
      await assert.rejects(
        window.registerGlobalShortcut(SHORTCUT, () => {}),
        command
      )
      await assert.rejects(
        window.postNotification(CONTENT, () => {}),
        command
      )
      expect(app.diagnostics.serviceRequests).toBe(0)
      await healthy(app)
    }))

  test('a dismissal delivered before the post acknowledgement cancels the posting call', () =>
    withScripted(async (app, control) => {
      const window = await app.openWindow({ title: 'Early dismissal' })
      control.script({
        post_notification: {
          before: [
            {
              type: 'notification_dismissed',
              sequence: '$sequence',
              window_id: '$window',
              notification_id: '$notification',
              reason: 'expired',
            },
          ],
          delayMs: 50,
        },
      })
      const events: NotificationEvent[] = []
      await assert.rejects(
        window.postNotification(CONTENT, (event) => {
          events.push(event)
        }),
        (error: unknown) =>
          error instanceof NativeServiceError &&
          error.service === 'notifications' &&
          error.code === 'cancelled'
      )
      expect(events.map((event) => event.type)).toEqual(['notification_dismissed'])
      expect(events[0]!.signal.aborted).toBe(true)
      await healthy(app)
    }))

  for (const service of ['shortcut', 'notification'] as const) {
    const release = service === 'shortcut' ? 'unregister_global_shortcut' : 'withdraw_notification'
    const own = (window: NativeWindow) =>
      service === 'shortcut'
        ? window.registerGlobalShortcut(SHORTCUT, () => {}).then((item) => () => item.unregister())
        : window.postNotification(CONTENT, () => {}).then((item) => () => item.withdraw())

    test(`${service} release tolerates an already-ended native owner`, () =>
      withScripted(async (app, control) => {
        const window = await app.openWindow({ title: 'Ended owner' })
        const end = await own(window)
        control.script({ [release]: { error: 'invalid_handle' } })
        await end()
        await until(() => app.diagnostics.serviceRequests === 0)
        await healthy(app)
      }))

    test(`${service} release reports an unexpected native failure while running`, () =>
      withScripted(async (app, control) => {
        const window = await app.openWindow({ title: 'Failed release' })
        const end = await own(window)
        control.script({ [release]: { error: 'native_failure' } })
        await assert.rejects(
          end(),
          (error: unknown) => error instanceof NativeCommandError && error.code === 'native_failure'
        )
        await until(() => app.diagnostics.serviceRequests === 0)
        await healthy(app)
      }))

    test(`${service} release in flight at shutdown settles with the application`, () =>
      withScripted(async (app, control) => {
        const window = await app.openWindow({ title: 'Release at shutdown' })
        const end = await own(window)
        control.script({ [release]: { hold: true } })
        const ending = end()
        await until(() => app.diagnostics.serviceRequests === 1)
        await app.shutdown()
        await ending
        await app.closed
      }))

    test(`a ${service} event routed through another window is a protocol violation`, () =>
      withScripted(async (app, control) => {
        const owner = await app.openWindow({ title: 'Owner' })
        await app.openWindow({ title: 'Other' })
        const frame =
          service === 'shortcut'
            ? { type: 'global_shortcut', shortcut_id: '$shortcut' }
            : { type: 'notification_activated', notification_id: '$notification' }
        control.script({
          [service === 'shortcut' ? 'register_global_shortcut' : 'post_notification']: {
            after: [{ ...frame, sequence: '$sequence', window_id: '$other' }],
          },
        })
        await own(owner).catch(() => {})
        await assert.rejects(
          app.closed,
          (error: unknown) =>
            error instanceof ProtocolError && /outside its owner/.test(error.message)
        )
      }))
  }

  test('an event naming an unallocated window is a protocol violation', () =>
    withScripted(async (app, control) => {
      control.script({
        open: { after: [{ type: 'closed', sequence: '$sequence', window_id: 99 }] },
      })
      await app.openWindow({ title: 'Trigger' }).catch(() => {})
      await assert.rejects(
        app.closed,
        (error: unknown) =>
          error instanceof ProtocolError && /unallocated window/.test(error.message)
      )
    }))

  test('a click targeting a non-button node is a protocol violation', () =>
    withScripted(async (app, control) => {
      const window = await app.openWindow({ title: 'Wrong click target' })
      control.script({
        batch: {
          after: [{ type: 'click', sequence: '$sequence', window_id: '$window', $route: 'text' }],
        },
      })
      await text(window).catch(() => {})
      await assert.rejects(
        app.closed,
        (error: unknown) =>
          error instanceof ProtocolError &&
          /Native click targeted a non-button node/.test(error.message)
      )
    }))

  test('close tolerates a window the native host already ended', () =>
    withScripted(async (app, control) => {
      const window = await app.openWindow({ title: 'Already ended' })
      control.script({ close: { error: 'invalid_handle' } })
      await window.close()
      await window.closed
      expect(app.diagnostics.windows).toBe(0)
      await healthy(app)
    }))

  test('a failed native close shuts the application down rather than leak the window', () =>
    withScripted(async (app, control) => {
      const window = await app.openWindow({ title: 'Failed close' })
      control.script({ close: { error: 'native_failure' } })
      await assert.rejects(
        window.close(),
        (error: unknown) => error instanceof NativeCommandError && error.code === 'native_failure'
      )
      await app.closed
      await assert.rejects(app.openWindow({ title: 'After failure' }), /shutting down/)
      expect(app.diagnostics.windows).toBe(0)
    }))
})
