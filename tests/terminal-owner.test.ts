import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { openSync, closeSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  NativeTerminalDriver,
  type NativeTerminalConfiguration,
} from '../packages/runtime/src/terminal-owner.ts'
import type { TerminalDriverObserver } from '../packages/runtime/src/terminal.ts'

const pinnedRuntimeTest = test.skipIf(Bun.version !== '1.4.3')
const python = realpathSync(process.env['PYTHON'] ?? Bun.which('python3')!)
const bytes = await Bun.file(python).bytes()
const fd = process.platform === 'win32' ? -1 : openSync('/dev/null', 'r')
const config: NativeTerminalConfiguration = {
  version: '0.1.0',
  protocol: 2,
  executable: python,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  hostFd: fd,
  platform: process.platform,
  arch: process.arch,
}
const options = (mode: string, signal?: AbortSignal) => ({
  executable: resolve('tests/fixtures/terminal-owner-protocol.py'),
  argv: [mode],
  cwd: process.cwd(),
  env: process.platform === 'win32' ? { SystemRoot: process.env['SystemRoot']! } : {},
  cols: 80,
  rows: 24,
  name: 'xterm-256color',
  spawnTimeoutMs: 1000,
  ...(signal ? { signal } : {}),
})
function observations(throwOutput = false) {
  let finish!: (value: string) => void
  let closed!: () => void
  const result = new Promise<string>((resolve) => {
    finish = resolve
  })
  const closure = new Promise<void>((resolve) => {
    closed = resolve
  })
  const observer: TerminalDriverObserver = {
    output() {
      if (throwOutput) throw new Error('deliberate observer failure')
    },
    terminalClosed() {
      closed()
    },
    processExited() {
      finish('exited')
    },
    processNotStarted() {
      finish('not-started')
    },
    processFailed() {
      finish('unknown')
    },
  }
  return { observer, result, closure }
}
test('native discovery fails closed on identity, protocol, profile and digest mismatches', () => {
  for (const change of [
    { protocol: 1 },
    { sha256: '0'.repeat(64) },
    { bytes: 0 },
    { platform: 'other' },
    { executable: 'relative' },
  ])
    expect(
      () =>
        new NativeTerminalDriver(
          { ...config, ...change } as NativeTerminalConfiguration,
          'non-detaching'
        )
    ).toThrow()
  expect(() => new NativeTerminalDriver(config, 'interactive' as 'non-detaching')).toThrow()
})
pinnedRuntimeTest(
  'attested pre-command failures do not exhaust the global 64-owner cap',
  async () => {
    const driver = new NativeTerminalDriver(config, 'non-detaching')
    for (let index = 0; index < 66; index++) {
      const observation = observations()
      await expect(driver.spawn(options('no-command'), observation.observer)).rejects.toMatchObject(
        {
          code: 'SPAWN_FAILED',
        }
      )
      expect(await observation.result).toBe('not-started')
      await observation.closure
    }
  },
  15000
)
pinnedRuntimeTest(
  'wrong version, early EOF and cancelled pre-admission owners settle without unhandled rejection',
  async () => {
    const driver = new NativeTerminalDriver(config, 'non-detaching')
    for (const mode of ['bad-version', 'early-eof', 'late-hello']) {
      const observation = observations()
      const controller = new AbortController()
      const pending = driver.spawn(options(mode, controller.signal), observation.observer)
      if (mode === 'late-hello') setTimeout(() => controller.abort(), 30)
      await expect(pending).rejects.toMatchObject({ code: 'SPAWN_FAILED' })
      expect(await observation.result).toBe('not-started')
      await observation.closure
    }
  }
)
pinnedRuntimeTest(
  'malformed, oversized and late readiness keep unknown ownership; callback failures are contained',
  async () => {
    const driver = new NativeTerminalDriver(config, 'non-detaching')
    for (const mode of ['malformed', 'oversized', 'late-ready', 'callback']) {
      const observation = observations(mode === 'callback')
      const pending = driver.spawn(
        { ...options(mode), spawnTimeoutMs: mode === 'late-ready' ? 100 : 1000 },
        observation.observer
      )
      await pending.catch(() => {})
      expect(await observation.result).toBe('unknown')
      await observation.closure
    }
  }
)
pinnedRuntimeTest('unsupported signals fail before writing to the owner lease', async () => {
  const observation = observations()
  const driver = await new NativeTerminalDriver(config, 'non-detaching').spawn(
    options('signals'),
    observation.observer
  )
  expect(() => driver.signal('SIGSTOP')).toThrow()
  driver.signal('SIGKILL')
  expect(await observation.result).toBe('unknown')
  await observation.closure
})

afterAll(() => {
  if (fd >= 0) closeSync(fd)
})
