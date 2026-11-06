/**
 * Real GPUI message and confirm dialog qualification in an isolated Xvfb +
 * openbox session. Dialogs are drawn by public core on the modal overlay; OS
 * input comes from XTEST (xdotool) and native geometry and focus come from the
 * host's nonce-tagged paint evidence, so every click targets the position GPUI
 * actually painted.
 */
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  type MessageDialogOptions,
  type MessageDialogResult,
  type NativeApplication,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_MESSAGE_DIALOG_EVIDENCE']
const mode = process.env['BUN_NATIVE_MESSAGE_DIALOG_MODE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !process.env['BUN_NATIVE_HOST'] ||
  (mode !== 'development' && mode !== 'aot') ||
  !process.env['DISPLAY'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error('An isolated X11 display, evidence directory, host and mode are required')
const executable = process.env['BUN_NATIVE_HOST']
const evidenceLog = process.env['BUN_NATIVE_EVIDENCE_LOG'] ?? ''
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE'] ?? ''
if (!isAbsolute(evidenceLog) || !/^[0-9a-f]{32}$/.test(nonce))
  throw new Error('An absolute native evidence log and a 32-hex-digit nonce are required')

const TITLE = 'Message dialog qualification'
const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

async function waitFor(check: () => boolean, description: string, timeout = 5_000) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(5)
  }
}

type Rect = [number, number, number, number]
type Layout = {
  tree_revision: number
  layout: {
    status: string
    focused_node_id: number | null
    nodes: { node_id: number; bounds: Rect }[]
  }
}
type Rendered = {
  tree_revision: number
  nodes: { node_id: number; element: { kind: string; text?: string } }[]
}

function records<T>(type: string): T[] {
  let text = ''
  try {
    text = readFileSync(evidenceLog, 'utf8')
  } catch {
    return []
  }
  const result: T[] = []
  // The host appends whole lines while this polls: a last line without its
  // newline is still being written and is read on the next poll.
  for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
    if (!line) continue
    const value = JSON.parse(line) as { nonce?: string; type?: string }
    if (value.nonce === nonce && value.type === type) result.push(value as T)
  }
  return result
}

/** The latest painted layout at or after a committed tree revision. */
async function painted(window: NativeWindow, check: (layout: Layout) => boolean = () => true) {
  let found: Layout | undefined
  await waitFor(() => {
    found = records<Layout>('layout')
      .filter(
        (entry) => entry.tree_revision >= window.revision && entry.layout.status === 'complete'
      )
      .findLast(check)
    return found !== undefined
  }, 'native paint evidence at revision ' + window.revision)
  return found!
}

/** The node the latest rendered tree shows with this label, if any. */
function labelled(label: string): number | undefined {
  return records<Rendered>('rendered')
    .at(-1)
    ?.nodes.find((entry) => entry.element.text === label)?.node_id
}
function nodeId(label: string): number {
  const id = labelled(label)
  if (id === undefined) throw new Error('No rendered node labelled ' + label)
  return id
}

function bounds(layout: Layout, id: number): Rect {
  const node = layout.layout.nodes.find((entry) => entry.node_id === id)
  if (!node) throw new Error('No painted bounds for node ' + id)
  return node.bounds
}

let windowId = ''
async function activate() {
  const ids = (await run(['xdotool', 'search', '--sync', '--name', '^' + TITLE + '$'])).split('\n')
  assert.equal(ids.length, 1, 'expected exactly one owned window named ' + TITLE)
  windowId = ids[0]!
  await run(['xdotool', 'windowactivate', '--sync', windowId])
}
const press = (...keys: string[]) => run(['xdotool', 'key', '--clearmodifiers', ...keys])
const type = (text: string) => run(['xdotool', 'type', '--delay', '20', text])
async function click([x, y, width, height]: Rect) {
  const at = [String(Math.round(x + width / 2)), String(Math.round(y + height / 2))]
  await run(['xdotool', 'mousemove', '--window', windowId, ...at, 'click', '1'])
}
/** Capture the owned window and read one displayed pixel as 0xRRGGBB. */
async function screenshot(name: string, [x, y]: [number, number]): Promise<number> {
  const file = join(output!, name + '.png')
  await run(['import', '-window', windowId, file])
  const text = await run(['convert', file, '-crop', `1x1+${x}+${y}`, '-depth', '8', 'txt:-'])
  const hex = /#([0-9A-Fa-f]{6})/.exec(text)
  if (!hex) throw new Error('Unreadable screenshot pixel: ' + text)
  return Number.parseInt(hex[1]!, 16)
}
/** Paint evidence can precede the presented frame under a software renderer. */
async function displayed(name: string, [x, y]: [number, number], expected: number) {
  const until = performance.now() + 2_000
  let value = await screenshot(name, [Math.floor(x), Math.floor(y)])
  while (value !== expected && performance.now() < until) {
    await Bun.sleep(50)
    value = await screenshot(name, [Math.floor(x), Math.floor(y)])
  }
  return value
}

/** Wait until the dialog with this default label is painted with focus on it. */
async function focusedOn(window: NativeWindow, label: string) {
  await waitFor(() => labelled(label) !== undefined, 'the dialog button ' + label)
  return painted(window, (entry) => entry.layout.focused_node_id === nodeId(label))
}

/** Wait until the dialog with this label is gone from the painted tree. */
async function removed(window: NativeWindow, label: string) {
  await waitFor(() => labelled(label) === undefined, 'removal of ' + label)
  return painted(window)
}

const SAVE: MessageDialogOptions = {
  title: 'Unsaved changes',
  message: 'Save the document before closing?',
  detail: 'Unsaved edits are lost.\nThis cannot be undone.',
  buttons: [
    { id: 'save', label: 'Save', kind: 'primary' },
    { id: 'discard', label: 'Discard', kind: 'destructive' },
    { id: 'cancel', label: 'Cancel' },
  ],
  cancelButton: 'cancel',
}

async function qualify(app: NativeApplication) {
  assert.deepEqual(app.serviceCapabilities.messageDialogs, {
    availability: 'available',
    scope: 'owned_window',
    backend: 'modal_overlay',
  })
  const window = await app.openWindow({ title: TITLE, width: 520, height: 400 })
  const focus: string[] = []
  const clicks: string[] = []
  const names = new Map<unknown, string>()
  const name = (node: unknown) => names.get(node) ?? 'dialog-internal'
  window.on(window.root, 'focus', (event) => void focus.push(name(event.node)), { capture: true })
  window.on(window.root, 'click', (event) => void clicks.push(name(event.node)), { capture: true })
  const base = await window.batch((batch) => {
    const opener = batch.create({ kind: 'button', text: 'Delete file', style: { width: 200 } })
    const field = batch.create({ kind: 'input', value: '', style: { width: 240, height: 36 } })
    batch.append(window.root, opener)
    batch.append(window.root, field)
    return { opener, field }
  })
  names.set(base.opener, 'opener')
  names.set(base.field, 'field')
  const initial = await painted(window)
  await activate()

  // Focus the editor and type so focus return can be observed.
  const fieldId = records<Rendered>('rendered')
    .at(-1)
    ?.nodes.find((entry) => entry.element.kind === 'input')?.node_id
  assert.ok(fieldId !== undefined, 'the editor is rendered')
  await click(bounds(initial, fieldId))
  await waitFor(() => focus.at(-1) === 'field', 'editor focus')
  await type('note')
  await waitFor(() => window.input(base.field).value === 'note', 'typed value')

  // 1. Opening moves focus to the default button and covers the window.
  let result: Promise<MessageDialogResult> = window.showMessageDialog(SAVE)
  let layout = await focusedOn(window, 'Save')
  const save = bounds(layout, nodeId('Save'))
  const opener = bounds(layout, nodeId('Delete file'))
  const title = bounds(layout, nodeId('Unsaved changes'))
  // Panel surface and the default theme's accent on the default button.
  const surface = await displayed('message-dialog', [title[0] - 4, title[1] + 2], 0xffffff)
  assert.equal(surface, 0xffffff, 'the dialog panel paints the theme surface')
  // Inside the button padding, past any 3-pixel inset focus ring.
  const accent = await displayed('message-dialog', [save[0] + 5, save[1] + save[3] / 2], 0x2255cc)
  assert.equal(accent, 0x2255cc, 'the primary button paints the theme accent')
  record('openFocusesDefault', {
    focused: 'Save',
    panelSurface: surface.toString(16),
    primaryButton: accent.toString(16),
    buttons: ['Save', 'Discard', 'Cancel'].map((label) => bounds(layout, nodeId(label))),
  })

  // 2. Tab and Shift-Tab stay inside the dialog; the editor is never reached.
  const order: string[] = []
  const focusedLabel = (entry: Layout) =>
    ['Save', 'Discard', 'Cancel'].find(
      (label) => labelled(label) === entry.layout.focused_node_id
    ) ?? 'outside'
  for (const [key, expected] of [
    ['Tab', 'Discard'],
    ['Tab', 'Cancel'],
    ['Tab', 'Save'],
    ['shift+Tab', 'Cancel'],
  ] as const) {
    await press(key)
    layout = await painted(window, (entry) => focusedLabel(entry) === expected)
    order.push(focusedLabel(layout))
  }
  record('tabTrapped', { order })

  // 3. A real click on a covered control reaches the backdrop, not the control.
  await click(opener)
  await Bun.sleep(300)
  assert.deepEqual(clicks, [], 'the covered opener stayed inert')

  // 4. A real click on a dialog button resolves with its id; focus returns.
  await click(bounds(await painted(window), nodeId('Discard')))
  assert.deepEqual(await result, { kind: 'button', id: 'discard' })
  await removed(window, 'Discard')
  await waitFor(() => focus.at(-1) === 'field', 'focus return to the editor')
  assert.deepEqual(clicks, [], 'dialog clicks are not delivered to application listeners')
  record('clickButton', { result: { kind: 'button', id: 'discard' }, focusReturn: focus.at(-1) })

  // 5. Enter activates the focused default button.
  result = window.showMessageDialog(SAVE)
  await focusedOn(window, 'Save')
  await press('Return')
  assert.deepEqual(await result, { kind: 'button', id: 'save' })
  await removed(window, 'Save')
  record('enterDefault', { result: { kind: 'button', id: 'save' } })

  // 6. Escape activates the cancel button.
  result = window.showMessageDialog(SAVE)
  await focusedOn(window, 'Save')
  await press('Escape')
  assert.deepEqual(await result, { kind: 'button', id: 'cancel' })
  await removed(window, 'Save')
  record('escapeCancels', { result: { kind: 'button', id: 'cancel' } })

  // 7. Escape is ignored without a cancel button unless the dialog is dismissible.
  result = window.showMessageDialog({
    title: 'Notice',
    message: 'The export finished.',
    buttons: [{ id: 'ok', label: 'Close notice' }],
  })
  await focusedOn(window, 'Close notice')
  await press('Escape')
  await Bun.sleep(300)
  assert.ok(labelled('Close notice') !== undefined, 'Escape left the dialog open')
  await press('space')
  assert.deepEqual(await result, { kind: 'button', id: 'ok' })
  await removed(window, 'Close notice')
  result = window.showMessageDialog({
    title: 'Notice',
    message: 'The export finished.',
    buttons: [{ id: 'ok', label: 'Close notice' }],
    dismissible: true,
  })
  await focusedOn(window, 'Close notice')
  await click(opener) // The backdrop: a press outside the panel.
  assert.deepEqual(await result, { kind: 'dismissed' })
  await removed(window, 'Close notice')
  record('dismissal', { escapeWithoutCancel: 'ignored', backdropWhenDismissible: 'dismissed' })

  // 8. A listener awaiting a confirmation does not block the dialog's input.
  const answers: boolean[] = []
  window.onClick(base.opener, async () => {
    answers.push(
      await window.showConfirmDialog({
        title: 'Delete file',
        message: 'Delete report.txt?',
        confirmLabel: 'Delete',
        cancelLabel: 'Keep',
        destructive: true,
      })
    )
  })
  await click(opener)
  // A destructive confirmation focuses the safe choice.
  await focusedOn(window, 'Keep')
  await click(bounds(await painted(window), nodeId('Delete')))
  await waitFor(() => answers.length === 1, 'the awaiting listener')
  await removed(window, 'Keep')
  assert.deepEqual(answers, [true])
  record('confirmFromListener', { answers, focusedDefault: 'Keep' })

  // 9. Queued dialogs appear one at a time in call order.
  const first = window.showMessageDialog({ ...SAVE, title: 'First of two' })
  const second = window.showConfirmDialog({ title: 'Second of two', message: 'Continue?' })
  await focusedOn(window, 'Save')
  assert.equal(labelled('Second of two'), undefined, 'the second dialog waits unseen')
  await press('Return')
  assert.deepEqual(await first, { kind: 'button', id: 'save' })
  await focusedOn(window, 'OK')
  assert.equal(labelled('First of two'), undefined)
  await press('Escape')
  assert.equal(await second, false)
  await removed(window, 'OK')
  record('queued', { first: 'save', second: false })

  // 10. An abort removes the shown dialog and rejects; focus returns.
  assert.equal(focus.at(-1), 'opener', 'focus returned to the control that opened the dialogs')
  await click(bounds(await painted(window), fieldId))
  await waitFor(() => focus.at(-1) === 'field', 'editor focus before abort')
  const controller = new AbortController()
  result = window.showMessageDialog(SAVE, { signal: controller.signal })
  await focusedOn(window, 'Save')
  controller.abort()
  await assert.rejects(
    result,
    (error: unknown) => error instanceof NativeServiceError && error.code === 'cancelled'
  )
  await removed(window, 'Save')
  await waitFor(() => focus.at(-1) === 'field', 'focus return after abort')
  await type('!')
  await waitFor(() => window.input(base.field).value === 'note!', 'typing after abort')
  record('abort', { rejected: 'cancelled', value: window.input(base.field).value })

  // 11. Closing the owner window rejects a shown and a queued dialog.
  const shown = window.showMessageDialog(SAVE)
  const queued = window.showMessageDialog(SAVE)
  // Both reject during close, before the assertions below observe them.
  for (const entry of [shown, queued]) void entry.catch(() => {})
  await focusedOn(window, 'Save')
  await window.close()
  for (const entry of [shown, queued])
    await assert.rejects(
      entry,
      (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
    )
  record('ownerClose', { rejected: 'invalid_handle' })

  // 12. Shutdown rejects a dialog shown in another window.
  const last = await app.openWindow({ title: TITLE, width: 360, height: 240 })
  const pending = last.showConfirmDialog({ title: 'Quit', message: 'Quit now?' })
  void pending.catch(() => {})
  await focusedOn(last, 'OK')
  // Boxed: returning the promise would wait for the dialog itself.
  return { pending }
}

const app = await createApplication({ executable })
let pending: Promise<boolean> | undefined
try {
  ;({ pending } = await qualify(app))
} finally {
  await app.shutdown()
  await app.closed
}
await assert.rejects(
  pending!,
  (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
)
record('shutdown', { rejected: 'invalid_handle' })
assert.deepEqual(Object.values(app.diagnostics), [0, 0, 0, 0, 0, 0, 0])
record('ownershipReleased', app.diagnostics)

writeFileSync(
  join(output, 'message-dialogs.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      display: 'isolated Xvfb with openbox',
      input: 'XTEST via xdotool',
      geometry: 'nonce-tagged native paint evidence',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Message dialog qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
