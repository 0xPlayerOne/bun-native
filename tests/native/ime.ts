/**
 * Real X11 input-method qualification with an actual IBus engine.
 *
 * Runs inside an isolated Xvfb + openbox + DBus session. An `ibus-daemon`
 * serves XIM and loads the Hangul engine; XTEST keys travel the way a user's do
 * (X server, XIM, IBus engine, GPUI's input handler, public Bun input events).
 * The host is launched through `env` with XMODIFIERS because the host never
 * sees `process.env` edits made inside Bun.
 */
import { createApplication } from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_TEXT_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_TEXT_MODE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !process.env['DISPLAY'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error('An isolated X11 display, evidence directory, host and mode are required')
const host = executable
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
let app: Awaited<ReturnType<typeof createApplication>> | undefined
try {
  await waitFor(
    async () => (await run(['ibus', 'list-engine']).catch(() => '')).includes('hangul'),
    'the IBus Hangul engine to register'
  )
  await run(['ibus', 'engine', 'hangul'])
  record('engine', await run(['ibus', 'engine']))

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
  await window.close()
} finally {
  await app?.shutdown()
  await app?.closed
  daemon.kill()
}
writeFileSync(
  join(output, 'result.json'),
  JSON.stringify({ status: 'passed', outcomes }, null, 2) + '\n'
)
console.log(JSON.stringify({ status: 'passed', mode, outcomes }))
