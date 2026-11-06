/**
 * Real Windows task dialog qualification against the native host. The host
 * shows the dialog through `TaskDialogIndirect` on its own thread; an
 * independent UI Automation oracle (windows-dialog-oracle.ps1, never GPUI)
 * reads the dialog's text and buttons and presses them, so a chosen button
 * is a real accessibility invoke, not a synthesized host event.
 */
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  type NativeApplication,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_TASK_DIALOG_EVIDENCE']
const host = process.env['BUN_NATIVE_HOST']
const oracle = process.env['BUN_NATIVE_WINDOWS_DIALOG_ORACLE']
if (
  process.platform !== 'win32' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  !oracle ||
  !isAbsolute(oracle)
)
  throw new Error(
    'Windows task dialogs need a Windows desktop, evidence directory, host and oracle'
  )

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function ui(command: string, title: string, name = ''): Promise<string> {
  const child = Bun.spawn(
    [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      oracle!,
      '-Command',
      command,
      '-Title',
      title,
      ...(name ? ['-Name', name] : []),
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`oracle ${command} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

const buttons = [
  { id: 'save', label: 'Save', kind: 'primary' },
  { id: 'discard', label: 'Discard', kind: 'destructive' },
  { id: 'cancel', label: 'Cancel' },
] as const

async function scenarios(app: NativeApplication, window: NativeWindow) {
  assert.deepEqual(app.serviceCapabilities.messageDialogs, {
    availability: 'available',
    scope: 'owned_window',
    backend: 'task_dialog',
  })
  record('backendIsTaskDialog', true)

  // 1. The custom text and buttons are what the OS shows; pressing one answers.
  {
    const title = 'Task dialog buttons'
    const pending = window.showMessageDialog({
      title,
      message: 'Save the document before closing?',
      detail: 'Unsaved edits are lost.',
      buttons,
      cancelButton: 'cancel',
    })
    const shown = JSON.parse(
      await ui('find', title).catch(async (error: unknown) => {
        const settled = await Promise.race([
          pending.then(
            (result) => `settled ${JSON.stringify(result)}`,
            (rejection: unknown) => `rejected ${String(rejection)}`
          ),
          Bun.sleep(0).then(() => 'still pending'),
        ])
        throw new Error(`${String(error)} (the dialog promise is ${settled})`)
      })
    ) as { texts: string[]; buttons: string[]; tree: string[] }
    assert.ok(shown.texts.some((text) => text.includes('Save the document before closing?')))
    assert.ok(shown.texts.some((text) => text.includes('Unsaved edits are lost.')))
    for (const label of ['Save', 'Discard', 'Cancel'])
      assert.ok(shown.buttons.includes(label), `${label} missing from ${JSON.stringify(shown)}`)
    record('shownTextAndButtons', shown)
    await ui('invoke', title, 'Discard')
    assert.deepEqual(await pending, { kind: 'button', id: 'discard' })
    await ui('absent', title)
    record('buttonChosen', 'discard')
  }

  // 2. Escape is the cancel button; without one it is ignored until dismissible.
  {
    const title = 'Task dialog escape'
    const pending = window.showMessageDialog({
      title,
      message: 'Press Escape.',
      buttons,
      cancelButton: 'cancel',
    })
    await ui('find', title)
    const how = await ui('escape', title)
    assert.deepEqual(await pending, { kind: 'button', id: 'cancel' })
    await ui('absent', title)
    record('escapeIsCancelButton', how)
  }
  {
    const title = 'Task dialog dismissible'
    const pending = window.showMessageDialog({
      title,
      message: 'Press Escape.',
      buttons: [{ id: 'ok', label: 'OK' }],
      dismissible: true,
    })
    await ui('find', title)
    const how = await ui('escape', title)
    assert.deepEqual(await pending, { kind: 'dismissed' })
    await ui('absent', title)
    record('escapeDismisses', how)
  }
  {
    const title = 'Task dialog ignores escape'
    const controller = new AbortController()
    const pending = window.showMessageDialog(
      { title, message: 'Escape does nothing.', buttons: [{ id: 'ok', label: 'OK' }] },
      { signal: controller.signal }
    )
    await ui('find', title)
    await ui('escape', title)
    await Bun.sleep(300)
    await ui('find', title) // still open
    // 3. Abort closes the OS dialog.
    controller.abort()
    await assert.rejects(pending, (error: unknown) => {
      return error instanceof NativeServiceError && error.code === 'cancelled'
    })
    await ui('absent', title)
    record('escapeIgnoredAndAbortCloses', true)
  }

  // 4. Dialogs of one window are shown one at a time, in call order.
  {
    const first = 'Task dialog first'
    const second = 'Task dialog second'
    const one = window.showMessageDialog({
      title: first,
      message: 'First.',
      buttons: [{ id: 'ok', label: 'OK' }],
    })
    const two = window.showMessageDialog({
      title: second,
      message: 'Second.',
      buttons: [{ id: 'ok', label: 'OK' }],
    })
    await ui('find', first)
    await ui('absent', second, '')
    await ui('invoke', first, 'OK')
    assert.deepEqual(await one, { kind: 'button', id: 'ok' })
    await ui('find', second)
    await ui('invoke', second, 'OK')
    assert.deepEqual(await two, { kind: 'button', id: 'ok' })
    record('queuedInOrder', true)
  }

  // 5. A confirm dialog answers true only for its confirm button.
  {
    const title = 'Task dialog confirm'
    const pending = window.showConfirmDialog({ title, message: 'Proceed?', confirmLabel: 'Go' })
    await ui('find', title)
    await ui('invoke', title, 'Go')
    assert.equal(await pending, true)
    await ui('absent', title)
    record('confirmTrue', true)
  }
}

const app = await createApplication({
  executable: host!,
  permissions: { taskDialogs: 'allow' },
})
let failure: unknown
try {
  const window = await app.openWindow({ title: 'Task dialog owner', width: 480, height: 320 })
  await scenarios(app, window)

  // 6. Closing the owner ends a live dialog and rejects its caller.
  const closing = await app.openWindow({
    title: 'Task dialog closing owner',
    width: 320,
    height: 200,
  })
  const title = 'Task dialog owner close'
  const pending = closing.showMessageDialog({
    title,
    message: 'The owner closes.',
    buttons: [{ id: 'ok', label: 'OK' }],
  })
  await ui('find', title)
  const rejected = assert.rejects(
    pending,
    (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
  )
  await closing.close()
  await rejected
  await ui('absent', title)
  record('ownerCloseEndsDialog', true)

  // 7. Shutdown ends a live dialog and the host exits cleanly.
  const shutdownTitle = 'Task dialog shutdown'
  const live = window.showMessageDialog({
    title: shutdownTitle,
    message: 'Shutdown closes this.',
    buttons: [{ id: 'ok', label: 'OK' }],
  })
  live.catch(() => {})
  await ui('find', shutdownTitle)
  await app.shutdown()
  await app.closed
  await ui('absent', shutdownTitle)
  record('shutdownEndsDialog', true)
} catch (error) {
  failure = error
  throw error
} finally {
  writeFileSync(
    join(output!, 'task-dialogs.json'),
    JSON.stringify({ platform: process.platform, outcomes, failed: failure !== undefined }, null, 2)
  )
  if (failure !== undefined) await app.shutdown().catch(() => {})
}
