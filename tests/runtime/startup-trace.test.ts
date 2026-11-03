import { expect, spyOn, test } from 'bun:test'
import { NativeHost } from '@bun-native/runtime'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function run(mode: string, enabled = true, nonce = 'owned-startup-diagnostic') {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-startup-'))
  const path = join(directory, 'events.jsonl')
  const environment = {
    BUN_NATIVE_STARTUP_TRACE: enabled ? '1' : '',
    BUN_NATIVE_EVIDENCE_LOG: mode === 'unwritable' ? directory : path,
    BUN_NATIVE_EVIDENCE_NONCE: nonce,
  }
  const previous = new Map(Object.keys(environment).map((name) => [name, process.env[name]]))
  let host: NativeHost | undefined
  let failure: Error | undefined
  try {
    Object.assign(process.env, environment)
    try {
      host = await NativeHost.launch({
        executable: process.execPath,
        args: [
          resolve(import.meta.dir, 'protocol-peer.ts'),
          mode === 'timeout' ? 'diagnostic-open-timeout' : 'normal',
        ],
        requestTimeoutMs: mode === 'timeout' ? 300 : 1_000,
      })
      for (let cycle = 0; cycle < (mode === 'budget' ? 60 : 1); cycle++) {
        await host.send({
          type: 'open',
          window_id: cycle + 1,
          root_id: cycle + 1,
          title: 'Never record this command payload',
          width: 560,
          height: 380,
        })
        await host.send({ type: 'close', window_id: cycle + 1 })
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      failure = error
    } finally {
      if (host)
        await host.shutdown().catch((error: unknown) => {
          if (!(error instanceof Error)) throw error
          failure ??= error
        })
    }
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const records = text
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line): Record<string, unknown> => JSON.parse(line))
    return { failure, text, records, exitCode: host && (await host.exited) }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

test('startup diagnostics are opt-in and do not record command payloads', async () => {
  const disabled = await run('normal', false)
  expect(disabled.failure).toBeUndefined()
  expect(disabled.exitCode).toBe(0)
  expect(disabled.text).toBe('')
  const enabled = await run('normal')
  expect(enabled.failure).toBeUndefined()
  expect(enabled.exitCode).toBe(0)
  expect(enabled.text).not.toContain('Never record this command payload')
  const open = enabled.records.filter((record) => record['request_id'] === 2)
  for (const record of enabled.records) {
    expect(record['nonce']).toBe('owned-startup-diagnostic')
    expect(record['stage']).toBe('startup-diagnostic')
    expect(record['source']).toBe('transport')
    expect(record['clock']).toBe('process_monotonic_relative')
    expect(typeof record['pid']).toBe('number')
  }
  const phases = open.map((record) => record['phase'])
  expect(phases.filter((phase) => phase !== 'response_received')).toEqual([
    'request_queued',
    'stdin_write_enter',
    'stdin_write_returned',
    'stdin_flush_enter',
    'stdin_flushed',
  ])
  expect(phases).toContain('response_received')
  // A response can arrive before the FileSink flush promise resolves. Never
  // impose a false cross-thread total order on those two observed boundaries.
  const times = enabled.records.map((record) => BigInt(String(record['elapsed_ns'])))
  expect(times.every((time, index) => index === 0 || time >= times[index - 1]!)).toBe(true)
  expect(enabled.records.at(-1)?.['phase']).toBe('transport_finished')
  expect(enabled.records.at(-1)?.['exit_code']).toBe(0)
})

test('a real unanswered open preserves its failed phase and bounded native stderr', async () => {
  const result = await run('timeout')
  expect(result.failure?.message).toBe('Native open request 2 timed out')
  const failed = result.records.find((record) => record['phase'] === 'transport_failed')
  expect(failed?.['error']).toBe('Native open request 2 timed out')
  expect(String(failed?.['stderr_tail'])).toHaveLength(4_096)
  expect(String(failed?.['stderr_tail'])).toContain('Owned diagnostic peer is waiting at open')
  expect(
    result.records.some(
      (record) => record['request_id'] === 2 && record['phase'] === 'stdin_flushed'
    )
  ).toBe(true)
  expect(
    result.records.some(
      (record) => record['request_id'] === 2 && record['phase'] === 'response_received'
    )
  ).toBe(false)
  expect(result.records.at(-1)?.['phase']).toBe('transport_finished')
})

test('startup trace records are bounded without terminating the actual session', async () => {
  const result = await run('budget')
  expect(result.failure).toBeUndefined()
  expect(result.exitCode).toBe(0)
  expect(result.records).toHaveLength(257)
  expect(result.records.filter((record) => record['phase'] === 'record_limit')).toHaveLength(1)
  expect(new Set(result.records.map((record) => record['host_pid'])).size).toBe(1)
  expect(result.records.at(-1)?.['phase']).toBe('transport_finished')
  expect(result.records.at(-1)?.['exit_code']).toBe(0)
})

test('invalid nonce cannot enable a startup trace', async () => {
  const result = await run('normal', true, 'invalid\nnonce')
  expect(result.failure?.message).toContain('Native startup tracing requires')
  expect(result.exitCode).toBeUndefined()
  expect(result.records).toHaveLength(0)
})

test('diagnostic file failure remains explicit and does not replace transport semantics', async () => {
  const warning = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const result = await run('unwritable')
    expect(result.failure).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledWith(
      'Bun Native startup trace unavailable; evidence file could not be appended'
    )
  } finally {
    warning.mockRestore()
  }
})
