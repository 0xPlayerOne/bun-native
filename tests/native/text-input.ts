/**
 * Real X11 text, focus, Unicode, composition, accessibility and scaling qualification.
 *
 * Runs inside an isolated Xvfb + openbox + DBus session. OS input comes from
 * XTEST (xdotool); every assertion reads public Bun events, the X server
 * (clipboard owner, window geometry), or an independent AT-SPI client. The
 * caller passes the host environment (GPUI_X11_SCALE_FACTOR, LC_CTYPE), since
 * the host never sees process.env changes made inside Bun.
 */
import { createApplication, type NativeNode, type NativeWindow } from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const output = process.env['BUN_NATIVE_TEXT_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_TEXT_MODE']
const scale = Number(process.env['GPUI_X11_SCALE_FACTOR'])
// The independent AT-SPI client is a separate system Python with PyGObject.
const atspiPython = process.env['BUN_NATIVE_ATSPI_PYTHON']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !(scale === 1 || scale === 2) ||
  !process.env['DISPLAY'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error(
    'An isolated X11 display, evidence directory, host, mode and explicit GPUI_X11_SCALE_FACTOR of 1 or 2 are required'
  )
const host = executable
// Resolved from the checkout, not import.meta, so the AOT executable finds it too.
const probe = resolve('tests/native/atspi-probe.py')

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
  return stdout.trim()
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
    await Bun.sleep(5)
  }
}

/** One real XTEST key press, then a bounded wait for its Bun-visible effect. */
const press = (...keys: string[]) => run(['xdotool', 'key', '--clearmodifiers', ...keys])

const FAMILY = '\u{1f469}‍\u{1f469}‍\u{1f467}'
const FLAG = '\u{1f1fa}\u{1f1f8}'
const COMBINING = 'Café'
const HEBREW = 'שלום'
const ARABIC = 'سلام'
const READ_ONLY = 'Read only ' + HEBREW + ' ' + FAMILY
const TITLE = 'Bun Native text qualification'

// The international layout provides real dead keys for the platform compose path.
await run(['setxkbmap', '-layout', 'us', '-variant', 'intl'])
// Bind the Hebrew letters to unused keycodes before launch. `xdotool type`
// would otherwise remap a keycode per character while the host is running, and
// a press can race the host's keymap reload and be dropped (observed in Xvfb).
const HEBREW_KEYSYMS = ['hebrew_shin', 'hebrew_lamed', 'hebrew_waw', 'hebrew_finalmem']
const unused = (await run(['xmodmap', '-pke']))
  .split('\n')
  .map((line) => /^keycode\s+(\d+) =\s*$/.exec(line)?.[1])
  .filter((code): code is string => code !== undefined)
  .slice(-HEBREW_KEYSYMS.length)
assert.equal(unused.length, HEBREW_KEYSYMS.length, 'unused keycodes for Hebrew keysyms')
for (const [index, keysym] of HEBREW_KEYSYMS.entries())
  await run(['xmodmap', '-e', `keycode ${unused[index]} = ${keysym}`])

let atspiEnabled = false
if (atspiPython) {
  // Enable the session accessibility bus before launch, as a screen reader would.
  await run([atspiPython, '-I', probe, 'enable'])
  atspiEnabled = true
}

const app = await createApplication({ executable: host, permissions: { windowDisplay: 'allow' } })
assert(app.capabilities.includes('input_states_v1'))
type Name = 'edit' | 'readonly' | 'disabled' | 'action' | 'paste'
const focusTrace: string[] = []
const values: Record<Name, string[]> = {
  edit: [],
  readonly: [],
  disabled: [],
  action: [],
  paste: [],
}
let clicks = 0
let window: NativeWindow | undefined
try {
  window = await app.openWindow({ title: TITLE, width: 420, height: 360 })
  const owned = window
  const nodes = await owned.batch((batch) => {
    batch.set(owned.root, {
      kind: 'box',
      style: { direction: 'column', padding: 12, gap: 8, background: 0xf4f5f7 },
    })
    const heading = batch.create({
      kind: 'text',
      text: 'Text ' + ARABIC + ' ' + HEBREW,
      style: { height: 28, font_size: 18 },
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
    for (const child of [heading, edit, readonly, disabled, action, paste])
      batch.append(owned.root, child)
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
  const lastEdit = () => values.edit.at(-1)

  const ids = (await run(['xdotool', 'search', '--sync', '--name', '^' + TITLE + '$'])).split('\n')
  assert.equal(ids.length, 1, 'exactly one owned window')
  const xid = ids[0]!

  type Entry = { role: string; text?: string; extents?: number[][] }
  /**
   * Bidirectional display oracle: the AT-SPI character extents of the focused
   * entry come from the host's painted glyphs. Latin characters advance to
   * the right, the Hebrew letters after them run right to left in logical
   * order, and every box covers dark glyph ink in a capture of the window.
   */
  const rtlLayout = async (text: string) => {
    let entry: Entry | undefined
    const until = performance.now() + 5_000
    while (!entry?.extents?.every((box) => box[2]! >= 0)) {
      const tree = JSON.parse(await run([atspiPython!, '-I', probe, 'dump', TITLE])) as {
        roles: Entry[]
      }
      entry = tree.roles.find((node) => node.role === 'entry' && node.text === text)
      if (performance.now() > until)
        throw new Error('no painted extents for ' + text + ': ' + JSON.stringify(entry))
      await Bun.sleep(50)
    }
    const boxes = entry!.extents!
    const characters = [...text]
    assert.equal(boxes.length, characters.length)
    const hebrew = characters.findIndex((character) => /[\u0590-\u05ff]/.test(character))
    for (let index = 1; index < hebrew; index += 1)
      assert(boxes[index]![0]! >= boxes[index - 1]![0]! + boxes[index - 1]![2]! - 1, 'LTR order')
    for (let index = hebrew + 1; index < characters.length; index += 1)
      assert(
        boxes[index]![0]! + boxes[index]![2]! <= boxes[index - 1]![0]! + 1,
        'each later Hebrew letter is painted left of the one before it'
      )
    const space = boxes[hebrew - 1]!
    assert(
      boxes.slice(hebrew).every((box) => box[0]! >= space[0]! + space[2]! - 1),
      'the Hebrew run is painted after the Latin run'
    )
    const capture = join(output, 'rtl-layout.png')
    await run(['import', '-window', xid, capture])
    const ink = await Promise.all(
      boxes
        .slice(hebrew)
        .map(async ([x, y, w, h]) =>
          Number(
            await run([
              'convert',
              capture,
              '-crop',
              `${w}x${h}+${x}+${y}`,
              '-colorspace',
              'Gray',
              '-format',
              '%[fx:minima]',
              'info:',
            ])
          )
        )
    )
    assert(
      ink.every((darkest) => darkest < 0.5),
      'every Hebrew box covers glyph ink: ' + ink.join()
    )
    return { boxes, ink }
  }
  await run(['xdotool', 'windowactivate', '--sync', xid])
  // The first enabled input owns initial focus once the window is active.
  await waitFor(() => focusTrace.includes('edit'), 'initial input focus')
  record('initialFocus', focusTrace.slice())

  // DPI: logical layout is scaled by the X11 scale factor on the actual window.
  const display = await owned.displaySnapshot()
  assert.equal(display.scaleFactor, scale)
  const geometry = await run(['xwininfo', '-id', xid])
  const width = Number(/Width: (\d+)/.exec(geometry)?.[1])
  const height = Number(/Height: (\d+)/.exec(geometry)?.[1])
  assert.equal(width, 420 * scale)
  assert.equal(height, 360 * scale)
  record('scaling', { scaleFactor: display.scaleFactor, physical: { width, height } })

  // Grapheme-correct caret movement and deletion through OS key input.
  const seed = COMBINING + ' ' + FAMILY + FLAG + '!'
  await owned.batch((batch) =>
    batch.set(edit, { kind: 'input', value: seed }, owned.input(edit).revision)
  )
  const graphemeSteps: Array<[string[], string | undefined]> = [
    [['BackSpace'], COMBINING + ' ' + FAMILY + FLAG],
    [['BackSpace'], COMBINING + ' ' + FAMILY],
    // One Left crosses the whole ZWJ family, one the space, one e+combining acute.
    [['Left', 'Left', 'Left', 'BackSpace'], 'Caé ' + FAMILY],
    [['Delete'], 'Ca ' + FAMILY],
    [['End', 'BackSpace'], 'Ca '],
  ]
  for (const [keys, expected] of graphemeSteps) {
    const count = values.edit.length
    await press(...keys)
    await waitFor(() => values.edit.length === count + 1, 'edit after ' + keys.join(' '))
    assert.equal(lastEdit(), expected)
  }
  record('graphemeEditing', values.edit.slice())

  // OS-typed Hebrew keysyms are committed in logical order.
  const typedFrom = values.edit.length
  for (const keysym of HEBREW_KEYSYMS) await press(keysym)
  await waitFor(
    () => lastEdit() === 'Ca ' + HEBREW,
    'typed Hebrew text',
    5_000,
    () => JSON.stringify(values.edit.slice(typedFrom))
  )
  assert.equal(values.edit.length - typedFrom, [...HEBREW].length)
  if (atspiEnabled) record('rtlLayout', await rtlLayout('Ca ' + HEBREW))
  // Backspace removes the logically previous (visually leftmost) letter.
  await press('BackSpace')
  await waitFor(() => lastEdit() === 'Ca ' + HEBREW.slice(0, -1), 'RTL backspace')
  record('rtlTyping', values.edit.slice(typedFrom))

  // Platform composition: a dead key is a marked preedit, then replaced on commit.
  await owned.batch((batch) =>
    batch.set(edit, { kind: 'input', value: 'ab' }, owned.input(edit).revision)
  )
  const composeFrom = values.edit.length
  await press('dead_acute')
  await waitFor(() => values.edit.length > composeFrom, 'compose preedit')
  const preedit = values.edit.slice(composeFrom)
  await press('e')
  await waitFor(() => lastEdit() === 'abé', 'compose commit')
  // A cancelled sequence commits its preedit and the uncomposable key.
  await press('dead_acute', 'q')
  await waitFor(
    () => lastEdit()?.startsWith('abé') === true && lastEdit()!.endsWith('q'),
    'compose cancel'
  )
  const composition = values.edit.slice(composeFrom)
  assert.deepEqual(preedit, ['ab\u00b4'])
  assert.deepEqual(composition, ['ab\u00b4', 'ab\u00e9', 'ab\u00e9\u00b4', 'ab\u00e9\u00b4q'])
  record('composition', { trace: composition, final: owned.input(edit).value })

  // Keyboard-only focus order skips the disabled input and wraps both ways.
  focusTrace.length = 0
  for (let index = 0; index < 4; index += 1) await press('Tab')
  await waitFor(() => focusTrace.filter((name) => !name.startsWith('-')).length === 4, 'Tab order')
  const forward = focusTrace.filter((name) => !name.startsWith('-'))
  assert.deepEqual(forward, ['readonly', 'action', 'paste', 'edit'])
  focusTrace.length = 0
  for (let index = 0; index < 2; index += 1) await press('shift+Tab')
  await waitFor(() => focusTrace.filter((name) => !name.startsWith('-')).length === 2, 'Shift+Tab')
  const backward = focusTrace.filter((name) => !name.startsWith('-'))
  assert.deepEqual(backward, ['paste', 'action'])
  // Keyboard activation of the focused button.
  await press('space')
  await waitFor(() => clicks === 1, 'keyboard button activation')
  record('focusOrder', { forward, backward, keyboardClicks: clicks })

  // Read-only: focus, select all and copy work; every edit path is rejected.
  await press('shift+Tab')
  await waitFor(() => focusTrace.at(-1) === 'readonly', 'read-only focus')
  await press('ctrl+a', 'ctrl+c')
  await waitFor(
    () => Bun.spawnSync(['xclip', '-o', '-selection', 'clipboard']).stdout.toString() === READ_ONLY,
    'read-only copy to the X11 clipboard'
  )
  await press('x', 'BackSpace', 'Delete', 'ctrl+x', 'ctrl+v', 'dead_acute', 'e')
  await Bun.sleep(300)
  assert.deepEqual(values.readonly, [])
  assert.equal(owned.input(nodes.readonly).value, READ_ONLY)
  // Paste into an editable input, then cut a grapheme-granular selection.
  await press('Tab', 'Tab')
  await waitFor(() => focusTrace.at(-1) === 'paste', 'paste focus')
  await press('ctrl+v')
  await waitFor(() => values.paste.at(-1) === READ_ONLY, 'paste of the copied text')
  await press('shift+Left', 'shift+Left', 'ctrl+x')
  await waitFor(() => values.paste.at(-1) === READ_ONLY.slice(0, -FAMILY.length - 1), 'cut')
  const cut = Bun.spawnSync(['xclip', '-o', '-selection', 'clipboard']).stdout.toString()
  assert.equal(cut, ' ' + FAMILY)
  await press('shift+Home', 'ctrl+c')
  await waitFor(
    () =>
      Bun.spawnSync(['xclip', '-o', '-selection', 'clipboard']).stdout.toString() ===
      READ_ONLY.slice(0, -FAMILY.length - 1),
    'shift+Home selection copy'
  )
  record('selectionClipboard', {
    readOnlyEdits: values.readonly.length,
    pasted: values.paste,
    cutSelection: cut,
  })

  // Disabling a focused input blurs it; it then rejects typing until re-enabled.
  await press('shift+Tab', 'shift+Tab', 'shift+Tab')
  await waitFor(() => focusTrace.at(-1) === 'edit', 'edit focus before disable')
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
  const after = owned.input(edit)
  await owned.batch((batch) =>
    batch.set(edit, { kind: 'input', value: after.value }, after.revision)
  )
  focusTrace.length = 0
  await press('Tab')
  await waitFor(() => focusTrace.includes('edit'), 're-enabled input is focusable again')
  record('disabledState', { focusAfterReenable: focusTrace.slice() })

  // Accessibility tree, read by an independent AT-SPI client over DBus.
  if (atspiEnabled) {
    const tree = JSON.parse(await run([atspiPython!, '-I', probe, 'dump', TITLE])) as {
      roles: Array<{ role: string; name: string; text?: string; caret?: number; states: string[] }>
    }
    writeFileSync(join(output, 'atspi-tree.json'), JSON.stringify(tree, null, 2) + '\n')
    const find = (role: string, predicate: (node: (typeof tree.roles)[number]) => boolean) =>
      tree.roles.find((node) => node.role === role && predicate(node))
    const button = find('push-button', (node) => node.name === 'Native action')
    assert(button, 'AT-SPI exposes the button by name')
    assert(button.states.includes('enabled') && button.states.includes('focusable'))
    const entries = tree.roles.filter((node) => node.role === 'entry')
    assert.equal(entries.length, 4)
    const readOnly = entries.find((node) => node.text === READ_ONLY)
    assert(readOnly, 'AT-SPI exposes the read-only value')
    // AccessKit 0.24 maps read-only and disabled to AT-SPI read-only without
    // enabled/sensitive; only the read-only entry stays focusable.
    assert(readOnly.states.includes('read-only') && !readOnly.states.includes('editable'))
    assert(readOnly.states.includes('focusable'))
    const disabledEntry = entries.find((node) => node.text === 'Disabled field')
    assert(disabledEntry, 'AT-SPI exposes the disabled value')
    assert(!disabledEntry.states.includes('enabled') && !disabledEntry.states.includes('sensitive'))
    assert(!disabledEntry.states.includes('focusable'))
    const editable = entries.filter((node) => node.states.includes('enabled'))
    assert.equal(editable.length, 2, 'two ordinary editable entries')
    assert(editable.every((node) => node.states.includes('editable')))
    const focused = entries.find((node) => node.states.includes('focused'))
    assert.equal(focused?.text, owned.input(edit).value, 'AT-SPI focus follows native focus')
    assert.equal(focused.caret, [...owned.input(edit).value].length, 'AT-SPI caret at the end')
    assert(
      find('label', (node) => node.name.includes(HEBREW)),
      'AT-SPI exposes text labels'
    )
    record('accessibility', {
      backend: 'AT-SPI via AccessKit',
      nodes: tree.roles.length,
      entries: entries.map(({ text, caret, states }) => ({ text, caret, states })),
    })
  } else {
    record('accessibility', { status: 'not-run', reason: 'BUN_NATIVE_ATSPI_PYTHON not set' })
  }

  await owned.close()
} finally {
  await app.shutdown()
  await app.closed
}
assert(Object.values(app.diagnostics).every((count) => count === 0))
const result = {
  status: 'passed',
  scenario: 'text-input',
  mode,
  scaleFactor: scale,
  elapsedMs: Math.round(performance.now() - started),
  outcomes,
}
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ status: 'passed', mode, scale }))
