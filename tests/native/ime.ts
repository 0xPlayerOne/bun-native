/**
 * Real X11 input-method qualification with an actual IBus engine.
 *
 * Runs inside an isolated Xvfb + openbox + DBus session. An `ibus-daemon`
 * serves XIM and loads the Hangul engine; XTEST keys travel the way a user's do
 * (X server, XIM, IBus engine, GPUI's input handler, public Bun input events).
 * The host is launched through `env` with XMODIFIERS because the host never
 * sees `process.env` edits made inside Bun.
 *
 * The independent panel tests/native/ibus-panel-probe.py takes the IBus panel
 * role (ibus-ui-gtk3's on a desktop) and reports what the daemon relays to it:
 * the caret rectangle the host gives XIM, against which a desktop panel places
 * its candidate window, and the engine's candidate list. The Hangul engine's
 * Hanja conversion is a real CJK candidate selection: the list is opened on a
 * composing syllable, the highlight is moved, and the selected Hanja replaces
 * the syllable.
 */
import { createApplication } from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const output = process.env['BUN_NATIVE_TEXT_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_TEXT_MODE']
// A system Python with PyGObject and the IBus typelib for the panel probe.
const ibusPython = process.env['BUN_NATIVE_IBUS_PYTHON']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !ibusPython ||
  !isAbsolute(ibusPython) ||
  !process.env['DISPLAY'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error(
    'An isolated X11 display, evidence directory, host, mode and IBus Python are required'
  )
const host = executable
// Resolved from the checkout, not import.meta, so the AOT executable finds it too.
const panelProbe = resolve('tests/native/ibus-panel-probe.py')
const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 10_000
) {
  const until = performance.now() + timeout
  while (!(await check())) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(20)
  }
}

const press = (...keys: string[]) => run(['xdotool', 'key', '--clearmodifiers', ...keys])

// The IBus daemon owns the XIM server; the Hangul engine composes syllables.
const daemon = Bun.spawn(['ibus-daemon', '--xim', '--panel', 'disable', '--replace'], {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'pipe',
})
type PanelEvent =
  | { event: 'ready' }
  | { event: 'focus_in'; context: string }
  | { event: 'cursor'; x: number; y: number; w: number; h: number }
  | { event: 'lookup'; visible: boolean; candidates: string[]; cursor: number; page_size: number }
  | { event: 'hide_lookup' }
const panelEvents: PanelEvent[] = []
let panel: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>> | undefined
let app: Awaited<ReturnType<typeof createApplication>> | undefined
try {
  await waitFor(
    async () => (await run(['ibus', 'list-engine']).catch(() => '')).includes('hangul'),
    'the IBus Hangul engine to register'
  )
  await run(['ibus', 'engine', 'hangul'])
  record('engine', await run(['ibus', 'engine']))

  const probe = Bun.spawn([ibusPython, '-I', panelProbe], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  panel = probe
  void (async () => {
    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of probe.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        panelEvents.push(JSON.parse(pending.slice(0, newline)) as PanelEvent)
        pending = pending.slice(newline + 1)
      }
    }
  })()
  await waitFor(() => panelEvents.some((event) => event.event === 'ready'), 'the IBus panel probe')

  app = await createApplication({
    executable: '/usr/bin/env',
    args: ['XMODIFIERS=@im=ibus', 'LC_CTYPE=en_US.UTF-8', host],
  })
  const window = await app.openWindow({ title: 'Bun Native IME', width: 420, height: 160 })
  const input = await window.batch((batch) => {
    batch.set(window.root, { kind: 'box', style: { direction: 'column', padding: 12 } })
    const node = batch.create({ kind: 'input', value: '', style: { width: 'fill', height: 40 } })
    batch.append(window.root, node)
    return node
  })
  const values: string[] = []
  window.onInput(input, (event) => void values.push(event.value))
  const ids = (await run(['xdotool', 'search', '--sync', '--name', '^Bun Native IME$'])).split('\n')
  assert.equal(ids.length, 1)
  await run(['xdotool', 'windowactivate', '--sync', ids[0]!])
  await Bun.sleep(500)
  const last = () => values.at(-1)

  const step = async (key: string, expected: string, description: string) => {
    await press(key)
    await waitFor(() => last() === expected, description)
    // The engine may clear and reinsert its preedit; require the value to hold.
    await Bun.sleep(150)
    assert.equal(last(), expected, description)
  }
  // The engine starts in Latin mode; Shift+Space switches it to Hangul. Its
  // mode change is not text, so no input event follows it.
  await press('shift+space')
  await Bun.sleep(300)
  assert.deepEqual(values, [])
  // Two-set Hangul: r = ㄱ, k = ㅏ, f = ㄹ. The engine composes inside one
  // preedit that GPUI replaces in the field on every update.
  await step('r', 'ㄱ', 'initial consonant preedit')
  await step('k', '가', 'syllable composed from consonant and vowel')
  await step('f', '갈', 'final consonant joins the syllable')
  // Backspace is handled by the engine: it undoes the last jamo, not the syllable.
  await step('BackSpace', '가', 'engine backspace removes the final consonant only')
  // Space commits the syllable and is itself inserted.
  await step('space', '가 ', 'space commits the syllable')
  await step('r', '가 ㄱ', 'a new preedit starts after the commit')
  await step('k', '가 가', 'second syllable')
  assert.equal(window.input(input).value, '가 가')
  record('composition', values.slice())

  // The caret position the host gives XIM (GPUI sends the bottom-right corner
  // of the caret's range as the spot location), which the daemon translates to
  // screen pixels and relays to the panel. A desktop panel places the
  // candidate window there. Without a spot the daemon falls back to the
  // window's bottom-left corner.
  const info = await run(['xwininfo', '-id', ids[0]!])
  const field = (name: string) => Number(new RegExp(`${name}:\\s+(-?\\d+)`).exec(info)?.[1])
  const client = {
    x: field('Absolute upper-left X'),
    y: field('Absolute upper-left Y'),
    width: field('Width'),
    height: field('Height'),
  }
  // The input: inside the 12-pixel padding, 40 pixels tall, as wide as the
  // window allows.
  const box = { left: 12, top: 12, right: client.width - 12, bottom: 52 }
  const spots = () =>
    panelEvents
      .filter(
        (event): event is Extract<PanelEvent, { event: 'cursor' }> => event.event === 'cursor'
      )
      .map((event) => ({ x: event.x - client.x, y: event.y - client.y }))
  const onInput = (spot: { x: number; y: number }) =>
    spot.x > box.left && spot.x <= box.right && spot.y > box.top && spot.y <= box.bottom
  await waitFor(() => spots().some(onInput), 'a caret position on the input relayed to the panel')
  const caret = spots().at(-1)!
  assert(onInput(caret), `the latest caret position is on the input: ${JSON.stringify(spots())}`)
  // The caret follows the composition: after "가 가" it is right of where the
  // first preedit put it.
  const first = spots().find(onInput)!
  assert(caret.x > first.x, `the caret moved with the text: ${JSON.stringify(spots())}`)
  record('caretPosition', { window: client, input: box, spots: spots() })

  // Hanja conversion (the engine's Hanja key, F9): the composing 가 opens a
  // candidate list in the panel; Down moves the highlight; Return selects.
  const lookups = () =>
    panelEvents.filter(
      (event): event is Extract<PanelEvent, { event: 'lookup' }> => event.event === 'lookup'
    )
  const opened = lookups().length
  await press('F9')
  await waitFor(
    () =>
      lookups()
        .slice(opened)
        .some((event) => event.visible && event.candidates.length > 1),
    'the Hanja candidate list in the panel'
  )
  const list = lookups()
    .slice(opened)
    .find((event) => event.visible)!
  assert(
    list.candidates.every((candidate) => /\p{Script=Han}/u.test(candidate)),
    `Hanja candidates for 가: ${JSON.stringify(list.candidates)}`
  )
  assert.equal(list.cursor, 0, 'the first candidate is highlighted')
  // Opening the list is not an edit.
  assert.equal(last(), '가 가', 'the composing syllable stays while the list is open')
  const moved = lookups().length
  await press('Down')
  await waitFor(
    () =>
      lookups()
        .slice(moved)
        .some((event) => event.visible && event.cursor === 1),
    'the highlight on the second candidate'
  )
  const chosen = list.candidates[1]!
  await step('Return', '가 ' + chosen, 'the selected Hanja replaces the composing syllable')
  await waitFor(
    () => panelEvents.slice(moved).some((event) => event.event === 'hide_lookup'),
    'the candidate list to close'
  )
  assert.equal(window.input(input).value, '가 ' + chosen)
  // The commit ended the composition: the next key starts a new syllable.
  await step('r', '가 ' + chosen + 'ㄱ', 'composition resumes after the selection')
  record('hanjaCandidates', {
    candidates: list.candidates,
    pageSize: list.page_size,
    selected: chosen,
    values: values.slice(),
  })
  await window.close()
} finally {
  await app?.shutdown()
  await app?.closed
  panel?.kill()
  daemon.kill()
  writeFileSync(join(output, 'panel-events.json'), JSON.stringify(panelEvents, null, 2) + '\n')
}
writeFileSync(
  join(output, 'result.json'),
  JSON.stringify({ status: 'passed', outcomes }, null, 2) + '\n'
)
console.log(JSON.stringify({ status: 'passed', mode, outcomes }))
