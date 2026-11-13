import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
let work = ''
let bin = ''
let scripts = ''

// Stand-ins record what each layer received: xvfb-run its server arguments,
// dbus-run-session its command, and native-linux-session.sh or
// native-wayland-session.sh its arguments and the environment a step set. Only
// the session layer is replaced; the two scripts under test are the
// repository's own.
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bun-native-dev-aot-'))
  bin = join(work, 'bin')
  scripts = join(work, 'scripts')
  mkdirSync(bin)
  mkdirSync(scripts)
  const record = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  record(
    'xvfb-run',
    [
      'printf "xvfb-run" >> "$CALLS"',
      'printf " [%s]" "$@" >> "$CALLS"',
      'printf "\\n" >> "$CALLS"',
      '[[ $1 == --auto-servernum ]] && shift',
      '[[ $1 == --server-args=* ]] && shift',
      'exec "$@"',
    ].join('\n')
  )
  record('dbus-run-session', '[[ $1 == -- ]] && shift\nexec "$@"')
  for (const name of ['native-x11-session.sh', 'native-linux-dev-aot.sh'])
    copyFileSync(join(root, 'scripts/quality', name), join(scripts, name))
  const session = (name: string, label: string, skip: number) =>
    writeFileSync(
      join(scripts, name),
      [
        'set -euo pipefail',
        `printf "${label}" >> "$CALLS"`,
        'printf " [%s]" "$@" >> "$CALLS"',
        'printf " env[%s]" "${STEP_EVIDENCE:-}" "${STEP_MODE:-}" "${STEP_NONCE:-}" >> "$CALLS"',
        'printf "\\n" >> "$CALLS"',
        `shift ${skip}`,
        'printf "ran %s\\n" "$*"',
        'if [[ -n "${STEP_EVIDENCE:-}" ]]; then printf "{}" > "$STEP_EVIDENCE/result.json"; fi',
      ].join('\n')
    )
  session('native-linux-session.sh', 'session', 2)
  session('native-wayland-session.sh', 'wayland', 1)
  record(
    'check',
    'printf "check" >> "$CALLS"\nprintf " [%s]" "$@" >> "$CALLS"\nprintf "\\n" >> "$CALLS"'
  )
})

afterAll(() => rmSync(work, { recursive: true, force: true }))

function run(script: string, args: string[]) {
  const evidence = mkdtempSync(join(work, 'evidence-'))
  const calls = join(work, `calls-${Math.random().toString(16).slice(2)}`)
  writeFileSync(calls, '')
  const result = Bun.spawnSync(['bash', join(scripts, script), ...args], {
    // MSYS=noglob: Git Bash on Windows would otherwise brace-expand '{mode}' in argv.
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      NATIVE_EVIDENCE: evidence,
      CALLS: calls,
      MSYS: 'noglob',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const lines = readFileSync(calls, 'utf8').replaceAll(evidence, '$E').trim().split('\n')
  return { result, lines, evidence }
}

test('the X11 session wrapper starts the same Xvfb and DBus session as the inline steps did', () => {
  const plain = run('native-x11-session.sh', ['$E/out', '--', 'bun', 'x.ts'])
  expect(plain.result.exitCode).toBe(0)
  expect(plain.lines).toEqual([
    'xvfb-run [--auto-servernum] [--server-args=-screen 0 1280x800x24 -nolisten tcp] [dbus-run-session] [--] [bash] [' +
      `${scripts}/native-linux-session.sh` +
      '] [$E/out] [--] [bun] [x.ts]',
    'session [$E/out] [--] [bun] [x.ts] env[] env[] env[]',
  ])
  const screens = run('native-x11-session.sh', [
    '--screen',
    '1280x800x24',
    '--screen',
    '1024x768x24',
    'out',
    'development',
    'bun',
  ])
  expect(screens.lines[0]).toContain(
    '[--server-args=-screen 0 1280x800x24 -screen 1 1024x768x24 -nolisten tcp]'
  )
  expect(screens.lines[1]).toStartWith('session [out] [development] [bun]')
})

test('dev/AOT runs each mode in order with its own evidence, environment and nonce', () => {
  const { result, lines, evidence } = run('native-linux-dev-aot.sh', [
    '--entry',
    'popups',
    '--dev',
    'bun tests/native/popups.ts',
    '--evidence',
    'popups-{mode}',
    '--run-log',
    '--require',
    'result.json',
    '--screen',
    '1280x1024x24',
    '--env',
    'STEP_EVIDENCE={evidence}',
    '--env',
    'STEP_MODE={mode}',
    '--env',
    'STEP_NONCE={nonce}',
  ])
  expect(result.exitCode).toBe(0)
  const sessions = lines.filter((line) => line.startsWith('session'))
  expect(sessions.map((line) => line.replace(/env\[[0-9a-f]{32}\]$/, 'env[NONCE]'))).toEqual([
    'session [$E/popups-development-session] [--] [bun] [tests/native/popups.ts] env[$E/popups-development] env[development] env[NONCE]',
    'session [$E/popups-aot-session] [--] [$E/popups-package/popups] env[$E/popups-aot] env[aot] env[NONCE]',
  ])
  const nonces = sessions.map((line) => /env\[([0-9a-f]{32})\]$/.exec(line)?.[1])
  expect(nonces[0]).not.toBe(nonces[1])
  for (const line of lines.filter((line) => line.startsWith('xvfb-run')))
    expect(line).toContain('[--server-args=-screen 0 1280x1024x24 -nolisten tcp]')
  expect(readdirSync(evidence).sort()).toEqual(['popups-aot', 'popups-development'])
  expect(readFileSync(join(evidence, 'popups-aot/run.log'), 'utf8')).toContain('ran ')
})

test('dev/AOT expands the session command around the application and defaults to the package', () => {
  const { result, lines } = run('native-linux-dev-aot.sh', [
    '--modes',
    'aot development',
    '--entry',
    'react',
    '--evidence',
    'react-{mode}-click',
    '--',
    'python3',
    'driver.py',
    '--mode',
    '{mode}',
    '--output',
    '{evidence}',
    '--',
    '{app}',
  ])
  expect(result.exitCode).toBe(0)
  expect(lines.filter((line) => line.startsWith('session'))).toEqual([
    'session [$E/react-aot-click-session] [--] [python3] [driver.py] [--mode] [aot] [--output] [$E/react-aot-click] [--] [$E/react-package/react] env[] env[] env[]',
    'session [$E/react-development-click-session] [--] [python3] [driver.py] [--mode] [development] [--output] [$E/react-development-click] [--] [bun] [$E/react-package/development/application.js] env[] env[] env[]',
  ])
})

test('dev/AOT fails a run that leaves no required evidence, and rejects unknown input', () => {
  const missing = run('native-linux-dev-aot.sh', [
    '--entry',
    'x',
    '--evidence',
    'x-{mode}',
    '--run-log',
    '--require',
    'absent.json',
  ])
  expect(missing.result.exitCode).toBe(1)
  expect(missing.result.stderr.toString()).toContain('The development run of x left no')
  expect(missing.lines.filter((line) => line.startsWith('session'))).toHaveLength(1)
  expect(run('native-linux-dev-aot.sh', ['--entry', 'x']).result.exitCode).toBe(2)
  expect(
    run('native-linux-dev-aot.sh', ['--entry', 'x', '--evidence', 'x', '--modes', 'jit']).result
      .exitCode
  ).toBe(2)
})

test('dev/AOT runs Wayland sessions under DBus, tees a named log and checks each run', () => {
  const { result, lines, evidence } = run('native-linux-dev-aot.sh', [
    '--session',
    'wayland',
    '--entry',
    'display-wayland',
    '--dev',
    'bun tests/native/display-wayland.ts',
    '--evidence',
    'display-wayland-{mode}',
    '--log',
    'fixture.log',
    '--require',
    'result.json',
    '--check',
    'check {mode} {evidence}/result.json',
    '--env',
    'STEP_EVIDENCE={evidence}',
    '--env',
    'STEP_MODE={mode}',
  ])
  expect(result.exitCode).toBe(0)
  expect(lines).toEqual([
    'wayland [$E/display-wayland-development-session] [bun] [tests/native/display-wayland.ts] env[$E/display-wayland-development] env[development] env[]',
    'check [development] [$E/display-wayland-development/result.json]',
    'wayland [$E/display-wayland-aot-session] [$E/display-wayland-package/display-wayland] env[$E/display-wayland-aot] env[aot] env[]',
    'check [aot] [$E/display-wayland-aot/result.json]',
  ])
  expect(readFileSync(join(evidence, 'display-wayland-aot/fixture.log'), 'utf8')).toContain('ran ')
  expect(
    run('native-linux-dev-aot.sh', [
      '--session',
      'wayland',
      '--screen',
      '1x1x24',
      '--entry',
      'x',
      '--evidence',
      'x',
    ]).result.exitCode
  ).toBe(2)
  expect(
    run('native-linux-dev-aot.sh', ['--session', 'mir', '--entry', 'x', '--evidence', 'x']).result
      .exitCode
  ).toBe(2)
})

test('native workflows start every X11 and Wayland session through the shared wrappers', () => {
  const workflows = join(root, '.github/workflows')
  const inline = readdirSync(workflows)
    .filter((name) => name.endsWith('.yml'))
    .filter((name) =>
      /xvfb-run|dbus-run-session -- bash scripts\/quality\/native-(linux|wayland)-session/.test(
        readFileSync(join(workflows, name), 'utf8')
      )
    )
  expect(inline).toEqual([])
})
