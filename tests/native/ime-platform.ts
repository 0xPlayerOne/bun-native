/**
 * Real OS input-method composition on macOS and Windows (#241).
 *
 * The Linux counterpart is tests/native/ime.ts (IBus Hangul over XIM). Here the
 * operating system's own Korean input method composes: on macOS the bundled
 * 2-Set Korean input source, selected through Text Input Sources
 * (tests/native/macos-input-oracle.m); on Windows the Microsoft Korean IME,
 * switched on in the host window with WM_INPUTLANGCHANGEREQUEST and
 * WM_IME_CONTROL (tests/native/windows-input-oracle.ps1). Keys are ordinary
 * virtual-key presses (CGEventPost or SendInput), so the input method, not
 * the test, produces every jamo and syllable. Values are read from public Bun
 * input events, which carry the marked (preedit) text while composing.
 */
import { createApplication } from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_IME_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_IME_MODE']
const driver = process.env['BUN_NATIVE_IME_INPUT']
const platform = process.platform
const mac = platform === 'darwin'
if (
  (platform !== 'darwin' && platform !== 'win32') ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !driver ||
  !isAbsolute(driver)
)
  throw new Error(
    'macOS or Windows, an evidence directory, the host, the mode and the platform input driver are required'
  )
const host = executable
const helper = driver

const TITLE = 'Bun Native platform IME'
const KOREAN_SOURCE = 'com.apple.inputmethod.Korean.2SetKorean'
const KOREAN_LAYOUT = '00000412'
const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, value }))
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

async function waitFor(check: () => boolean, description: string, timeout = 10_000) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(20)
  }
}

const oracle = (args: string[]) =>
  mac
    ? [helper, ...args]
    : [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helper,
        ...args,
      ]

/** The host is this process's direct child; its executable is the host path. */
async function hostPid(): Promise<string> {
  const children = (await run(['pgrep', '-P', String(process.pid)])).split('\n')
  for (const child of children.filter(Boolean)) {
    const command = await run(['ps', '-o', 'comm=', '-p', child])
    if (command === host || command.endsWith('/bun-native-host')) return child
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

let previousSource: string | undefined
if (mac) {
  // Select the Korean input mode before the host starts. Selected from this
  // background helper while the host was already frontmost, the source was
  // reported selected but the host's text input context kept typing Latin
  // letters (hosted macOS 15, Native Platforms run 42936020446: 'r' arrived as
  // "r"). A context created after the switch starts in the selected source.
  const available = JSON.parse(await run(oracle(['sources', 'com.apple.inputmethod.Korean'])))
  record('koreanSources', available)
  const selected = JSON.parse(await run(oracle(['select', KOREAN_SOURCE]))) as {
    previous: { id: string }
    selected: { id: string }
  }
  previousSource = selected.previous.id
  record('inputSource', selected)
  assert.equal(selected.selected.id, KOREAN_SOURCE)
}
const app = await createApplication({ executable: host })
try {
  const window = await app.openWindow({ title: TITLE, width: 420, height: 160 })
  const input = await window.batch((batch) => {
    batch.set(window.root, { kind: 'box', style: { direction: 'column', padding: 12 } })
    const node = batch.create({ kind: 'input', value: '', style: { width: 'fill', height: 40 } })
    batch.append(window.root, node)
    return node
  })
  const values: string[] = []
  let focused = false
  window.on(input, 'focus', () => void (focused = true))
  window.onInput(input, (event) => void values.push(event.value))
  await waitFor(() => focused, 'initial input focus')

  const pid = mac ? await hostPid() : ''
  const press = (key: string) =>
    run(oracle(mac ? ['key', pid, key] : ['key', TITLE, '-Argument', key]))
  if (mac) {
    await run(oracle(['activate', pid]))
    // A fresh process reads the system's current source with the host in front.
    const current = JSON.parse(await run(oracle(['current']))) as { id: string }
    record('inputSourceWithHostFrontmost', current)
    assert.equal(current.id, KOREAN_SOURCE, 'the Korean input mode is still selected')
  } else {
    await run(oracle(['foreground', TITLE]))
    let state = JSON.parse(await run(oracle(['ime', TITLE, '-Argument', KOREAN_LAYOUT]))) as {
      after: { language: string; open: number | null; conversionMode: number | null }
    }
    record('imeSwitch', state)
    assert.equal(state.after.language, '0412', 'the host window switched to the Korean IME')
    // IME_CMODE_HANGUL (1). If the request did not take, the Hangul key does.
    if (((state.after.conversionMode ?? 0) & 1) === 0) {
      await press('hangul')
      await Bun.sleep(200)
      state = { after: JSON.parse(await run(oracle(['imestate', TITLE]))) }
      record('imeAfterHangulKey', state.after)
    }
    assert.equal((state.after.conversionMode ?? 0) & 1, 1, 'the Korean IME is in Hangul mode')
  }
  await Bun.sleep(300)
  assert.deepEqual(values, [], 'switching the input method inserts no text')

  const last = () => values.at(-1)
  const step = async (key: string, expected: string, description: string) => {
    await press(key)
    await waitFor(() => last() === expected, description).catch(async (error: unknown) => {
      // The window thread's layout, open status and conversion mode at the
      // failure, which IMM reported as Korean, open and Hangul before the first
      // key in Native Platforms run 42938725505 while `r` still arrived as "r".
      if (!mac) record('imeStateAtFailure', JSON.parse(await run(oracle(['imestate', TITLE]))))
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} (observed ${JSON.stringify(values)})`
      )
    })
    // The input method may clear and reinsert its marked text; require it to hold.
    await Bun.sleep(150)
    assert.equal(last(), expected, description)
  }
  // Two-set Hangul: r = ㄱ, k = ㅏ, f = ㄹ.
  await step('r', 'ㄱ', 'initial consonant is marked text')
  await step('k', '가', 'syllable composed from consonant and vowel')
  await step('f', '갈', 'final consonant joins the syllable')
  await step('backspace', '가', 'the input method removes only the final consonant')
  await step('space', '가 ', 'space commits the syllable')
  await step('r', '가 ㄱ', 'a new composition starts after the commit')
  await step('k', '가 가', 'second syllable')
  assert.equal(window.input(input).value, '가 가')
  record('composition', values.slice())
  await window.close()
} finally {
  if (mac && previousSource) await run(oracle(['select', previousSource])).catch(() => '')
  await app.shutdown()
  await app.closed
}
assert(Object.values(app.diagnostics).every((count) => count === 0))
writeFileSync(
  join(output, 'result.json'),
  JSON.stringify(
    {
      status: 'passed',
      scenario: 'ime-platform',
      platform,
      mode,
      elapsedMs: Math.round(performance.now() - started),
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log(JSON.stringify({ status: 'passed', platform, mode }))
