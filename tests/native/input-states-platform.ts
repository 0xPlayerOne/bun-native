/**
 * Real macOS read-only and disabled input qualification (input_states_v1), in
 * the hosted runner's GUI session: the read-only and disabled cases of the
 * Linux X11 fixture tests/native/text-input.ts.
 *
 * OS input is CoreGraphics key events through the bounded SDK helper
 * (tests/native/macos-window-input.ts). Independent oracles: the general
 * pasteboard read with `pbpaste` (copy and cut) and the AXUIElement client
 * (tests/native/macos-accessibility-oracle.m) for the enabled and focused
 * states and AX focus requests. Effects are read from public Bun focus and input events.
 */
import { createApplication, type NativeNode, type NativeWindow } from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { hostPid, MacWindow } from './macos-window-input.ts'

const output = process.env['BUN_NATIVE_INPUT_STATES_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_INPUT_STATES_MODE']
const oracle = process.env['BUN_NATIVE_A11Y_ORACLE']
if (
  process.platform !== 'darwin' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !oracle ||
  !isAbsolute(oracle) ||
  !process.env['BUN_NATIVE_PLATFORM_HELPER']
)
  throw new Error(
    'macOS, an evidence directory, the host, the mode, the AX oracle and the OS input helper are required'
  )
const host = executable
const client = oracle

const TITLE = 'Bun Native input states qualification'
const READ_ONLY = 'Read-only text'
const SENTINEL = 'bun-native-pasteboard-sentinel'
const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[], stdin?: string): Promise<string> {
  const child = Bun.spawn(command, {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim()}`)
  return stdout
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeout = 5_000,
  observed?: () => string
) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until)
      throw new Error(
        'Timed out waiting for ' + description + (observed ? '; observed ' + observed() : '')
      )
    await Bun.sleep(10)
  }
}

/** The general pasteboard as plain text, read by an independent process. */
const pasteboard = () => run(['pbpaste'])
async function pasteboardIs(expected: string, description: string) {
  const until = performance.now() + 5_000
  for (;;) {
    const actual = await pasteboard()
    if (actual === expected) return
    if (performance.now() > until)
      throw new Error(`Timed out waiting for ${description}: pasteboard ${JSON.stringify(actual)}`)
    await Bun.sleep(50)
  }
}

type AxEntry = Record<string, unknown> & { role: string; value: unknown }
const flag = (value: unknown) => value === true || value === 1

const trust = JSON.parse(await run([client, 'trusted'])) as { trusted: boolean }
assert.equal(trust.trusted, true, 'the runner trusts the AX oracle for Accessibility')

const app = await createApplication({ executable: host })
assert(app.capabilities.includes('input_states_v1' as never), 'input_states_v1')
type Name = 'edit' | 'readonly' | 'disabled' | 'action' | 'paste'
const focusTrace: string[] = []
const values: Record<Name, string[]> = {
  edit: [],
  readonly: [],
  disabled: [],
  action: [],
  paste: [],
}
const trees: Record<string, AxEntry[]> = {}
let clicks = 0
let window: NativeWindow | undefined
let input: MacWindow | undefined
try {
  window = await app.openWindow({ title: TITLE, width: 420, height: 360 })
  const owned = window
  const nodes = await owned.batch((batch) => {
    batch.set(owned.root, {
      kind: 'box',
      style: { direction: 'column', padding: 12, gap: 8, background: 0xf4f5f7 },
    })
    const field = (value: string, extra: { disabled?: true; read_only?: true } = {}) =>
      batch.create({ kind: 'input', value, ...extra, style: { width: 'fill', height: 40 } })
    const edit = field('')
    const readonly = field(READ_ONLY, { read_only: true })
    const disabled = field('Disabled field', { disabled: true })
    const action = batch.create({
      kind: 'button',
      text: 'Native action',
      style: { width: 180, height: 40 },
    })
    const paste = field('')
    for (const child of [edit, readonly, disabled, action, paste]) batch.append(owned.root, child)
    return { edit, readonly, disabled, action, paste }
  })
  const named = Object.entries(nodes) as Array<[Name, NativeNode]>
  for (const [name, node] of named) {
    owned.on(node, 'focus', () => void focusTrace.push(name))
    owned.on(node, 'blur', () => void focusTrace.push('-' + name))
    if (node.kind === 'input')
      owned.onInput(node as NativeNode<'input'>, (event) => void values[name].push(event.value))
  }
  owned.onClick(nodes.action, () => void (clicks += 1))
  const edit = nodes.edit

  const pid = await hostPid(host)
  input = await MacWindow.open(TITLE, host, () => [420, 360])
  const press = (...keys: string[]) => input!.press(...keys)
  const fields = async (label: string) => {
    const tree = JSON.parse(await run([client, 'dump', String(pid), TITLE])) as AxEntry[]
    trees[label] = tree
    return tree.filter((entry) => entry.role === 'AXTextField')
  }
  const field = (entries: AxEntry[], value: string) => {
    const found = entries.find((entry) => entry.value === value)
    assert(found, `AX exposes the text field ${JSON.stringify(value)}`)
    return found
  }

  // The first enabled input owns initial focus once the window is active.
  await waitFor(() => focusTrace.includes('edit'), 'initial input focus')
  record('initialFocus', focusTrace.slice())

  // Accessibility states: AccessKit reports a disabled field as not enabled;
  // the read-only field stays enabled. AppKit reports AXFocused settable on
  // every AccessKit element (hosted run 43110442504 dumped it settable on the
  // disabled field), so focusability is judged by an AX focus request below.
  let initial: AxEntry[] = []
  const until = performance.now() + 10_000
  for (;;) {
    initial = await fields('initial')
    if (initial.length === 4 && initial.some((entry) => flag(entry['focused']))) break
    if (performance.now() > until)
      throw new Error('Timed out waiting for four AX text fields: ' + JSON.stringify(initial))
    await Bun.sleep(100)
  }
  const readOnlyField = field(initial, READ_ONLY)
  const disabledField = field(initial, 'Disabled field')
  assert.equal(flag(readOnlyField['enabled']), true, 'a read-only field is enabled')
  assert.equal(flag(disabledField['enabled']), false, 'a disabled field is not enabled')
  const editable = initial.filter((entry) => entry.value === '')
  assert.equal(editable.length, 2, 'two ordinary editable fields')
  assert(editable.every((entry) => flag(entry['enabled'])))
  assert.equal(
    initial.filter((entry) => flag(entry['focused'])).length,
    1,
    'exactly one focused field'
  )

  // AccessKit's setAccessibilityFocused: performs Focus only on a focusable
  // node (accesskit_macos 0.26.3 src/node.rs:638-650): an AX focus request
  // leaves focus where it is for the disabled field and moves it to the
  // read-only one. The read-only request runs second, so a late effect of the
  // first would show in the exact trace.
  const act = (value: string, verb: string) =>
    run([client, 'act', String(pid), TITLE, 'AXTextField', value, verb])
  focusTrace.length = 0
  const refused = JSON.parse(await act('Disabled field', 'request-focus')) as { error: number }
  await Bun.sleep(500)
  assert.deepEqual(focusTrace.slice(), [], 'AX focus on a disabled field moves no focus')
  await act(READ_ONLY, 'focus')
  await waitFor(() => focusTrace.at(-1) === 'readonly', 'AX focus on the read-only field')
  await press('shift+Tab')
  await waitFor(() => focusTrace.at(-1) === 'edit', 'Shift+Tab back to the first field')
  assert.deepEqual(focusTrace.slice(), ['-edit', 'readonly', '-readonly', 'edit'])
  record('accessibilityStates', {
    readOnly: { enabled: readOnlyField['enabled'], axFocus: 'moved' },
    disabled: { enabled: disabledField['enabled'], axFocus: 'unchanged', error: refused.error },
    // Recorded only: AppKit reports both settable on every AccessKit element.
    // A list, not an object keyed by value: an empty field's value is "", a
    // key PowerShell's ConvertFrom-Json rejects when the workflow reads it.
    settable: initial.map((entry) => ({
      value: String(entry.value),
      focus: entry['focusSettable'],
      valueSettable: entry['valueSettable'],
    })),
  })

  // Keyboard-only focus order skips the disabled input and wraps both ways.
  focusTrace.length = 0
  await press('Tab', 'Tab', 'Tab', 'Tab')
  await waitFor(
    () => focusTrace.filter((name) => !name.startsWith('-')).length === 4,
    'Tab order',
    5_000,
    () => focusTrace.join()
  )
  const forward = focusTrace.filter((name) => !name.startsWith('-'))
  assert.deepEqual(forward, ['readonly', 'action', 'paste', 'edit'])
  focusTrace.length = 0
  await press('shift+Tab', 'shift+Tab')
  await waitFor(() => focusTrace.filter((name) => !name.startsWith('-')).length === 2, 'Shift+Tab')
  const backward = focusTrace.filter((name) => !name.startsWith('-'))
  assert.deepEqual(backward, ['paste', 'action'])
  // Keyboard activation of the focused button.
  await press('space')
  await waitFor(() => clicks === 1, 'keyboard button activation')
  record('focusOrder', { forward, backward, keyboardClicks: clicks })

  // Read-only: focus, select all and copy work; every edit path is rejected.
  await run(['pbcopy'], SENTINEL)
  await pasteboardIs(SENTINEL, 'the sentinel pasteboard')
  await press('shift+Tab')
  await waitFor(() => focusTrace.at(-1) === 'readonly', 'read-only focus')
  await press('super+a', 'super+c')
  await pasteboardIs(READ_ONLY, 'read-only copy to the general pasteboard')
  // Typing, deletion, cut, paste and an Option+E dead-key composition.
  await press('x', 'BackSpace', 'Delete', 'super+x', 'super+v', 'alt+e', 'e')
  await Bun.sleep(300)
  assert.deepEqual(values.readonly, [])
  assert.equal(owned.input(nodes.readonly).value, READ_ONLY)
  await pasteboardIs(READ_ONLY, 'a rejected cut leaves the pasteboard')
  const readOnlyTree = field(await fields('read-only after edits'), READ_ONLY)
  assert.equal(flag(readOnlyTree['focused']), true, 'AX focus is on the read-only field')
  // Paste into an editable input, then cut a selection.
  await press('Tab', 'Tab')
  await waitFor(() => focusTrace.at(-1) === 'paste', 'paste focus')
  await press('super+v')
  await waitFor(
    () => values.paste.at(-1) === READ_ONLY,
    'paste of the copied text',
    5_000,
    () => JSON.stringify(values.paste)
  )
  await press('shift+Left', 'shift+Left', 'super+x')
  await waitFor(() => values.paste.at(-1) === READ_ONLY.slice(0, -2), 'cut')
  await pasteboardIs(READ_ONLY.slice(-2), 'the cut selection on the pasteboard')
  await press('shift+Home', 'super+c')
  await pasteboardIs(READ_ONLY.slice(0, -2), 'shift+Home selection copy')
  record('selectionClipboard', {
    readOnlyEdits: values.readonly.length,
    pasted: values.paste,
    oracle: 'pbpaste',
  })

  // Disabling a focused input blurs it; it then rejects typing until re-enabled.
  await press('shift+Tab', 'shift+Tab', 'shift+Tab')
  await waitFor(
    () => focusTrace.at(-1) === 'edit',
    'edit focus before disable',
    5_000,
    () => focusTrace.join()
  )
  const before = owned.input(edit)
  await owned.batch((batch) =>
    batch.set(edit, { kind: 'input', value: before.value, disabled: true }, before.revision)
  )
  await waitFor(() => focusTrace.at(-1) === '-edit', 'disabled input blur')
  const disabledFrom = values.edit.length
  await press('z', 'BackSpace')
  await Bun.sleep(300)
  assert.equal(values.edit.length, disabledFrom)
  assert.deepEqual(values.disabled, [])
  const whileDisabled = await fields('edit disabled')
  assert.equal(
    whileDisabled.filter((entry) => !flag(entry['enabled'])).length,
    2,
    'AX reports both disabled fields as not enabled'
  )
  const after = owned.input(edit)
  await owned.batch((batch) =>
    batch.set(edit, { kind: 'input', value: after.value }, after.revision)
  )
  focusTrace.length = 0
  await press('Tab')
  await waitFor(() => focusTrace.includes('edit'), 're-enabled input is focusable again')
  await press('o', 'k')
  await waitFor(() => values.edit.at(-1) === after.value + 'ok', 'typing after re-enable')
  record('disabledState', {
    focusAfterReenable: focusTrace.slice(),
    typedAfterReenable: values.edit.at(-1),
  })

  await owned.close()
} finally {
  writeFileSync(join(output, 'ax-trees.json'), JSON.stringify(trees, null, 2) + '\n')
  await app.shutdown()
  await app.closed
}
assert(Object.values(app.diagnostics).every((count) => count === 0))
const result = {
  status: 'passed',
  scenario: 'input-states-platform',
  platform: process.platform,
  client:
    'AXUIElement (macos-accessibility-oracle.m), pbpaste; CoreGraphics input (native-platform-macos.m)',
  mode,
  elapsedMs: Math.round(performance.now() - started),
  outcomes,
  osInput: input?.log ?? [],
}
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ status: 'passed', platform: process.platform, mode }))
