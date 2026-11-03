import type { Command, NativeEvent } from '@bun-native/protocol'
import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const MAX_RECORDS = 256

/** Explicit diagnostic mode only. This is not a request scheduler or transport proxy. */
export class StartupTrace {
  private readonly started = process.hrtime.bigint()
  private records = 0
  private unavailable = false

  private constructor(
    private readonly path: string,
    private readonly nonce: string
  ) {}

  static fromEnvironment(): StartupTrace | undefined {
    if (process.env['BUN_NATIVE_STARTUP_TRACE'] !== '1') return
    const path = process.env['BUN_NATIVE_EVIDENCE_LOG']
    const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
    if (
      !path ||
      !isAbsolute(path) ||
      !nonce ||
      Buffer.byteLength(nonce) > 128 ||
      [...nonce].some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || (code >= 127 && code <= 159)
      })
    )
      throw new Error('Native startup tracing requires an absolute evidence path and valid nonce')
    return new StartupTrace(path, nonce)
  }

  request(phase: string, command: Command, hostPid: number): void {
    this.write(phase, {
      host_pid: hostPid,
      request_id: command.id,
      command: command.type,
      ...('window_id' in command ? { window_id: command.window_id } : {}),
    })
  }

  response(event: NativeEvent, hostPid: number): void {
    if (!('id' in event)) return
    this.write('response_received', {
      host_pid: hostPid,
      request_id: event.id,
      response: event.type,
    })
  }

  failure(error: Error, stderr: string, hostPid: number): void {
    this.write(
      'transport_failed',
      { host_pid: hostPid, error: error.message.slice(-1_024), stderr_tail: stderr },
      true
    )
  }

  finished(exitCode: number | null, stderr: string, hostPid: number): void {
    this.write(
      'transport_finished',
      { host_pid: hostPid, exit_code: exitCode, stderr_tail: stderr },
      true
    )
  }

  private write(phase: string, fields: Record<string, unknown>, terminal = false): void {
    if (this.unavailable || (!terminal && this.records >= MAX_RECORDS)) return
    if (!terminal && this.records === MAX_RECORDS - 1) {
      phase = 'record_limit'
      fields = { host_pid: fields['host_pid'], maximum_records: MAX_RECORDS }
    }
    const record = {
      nonce: this.nonce,
      stage: 'startup-diagnostic',
      source: 'transport',
      pid: process.pid,
      clock: 'process_monotonic_relative',
      elapsed_ns: String(process.hrtime.bigint() - this.started),
      index: ++this.records,
      phase,
      ...fields,
    }
    try {
      appendFileSync(this.path, JSON.stringify(record) + '\n', { mode: 0o600 })
    } catch {
      this.unavailable = true
      // Do not replace the original transport result with a diagnostic I/O error.
      console.error('Bun Native startup trace unavailable; evidence file could not be appended')
    }
  }
}
