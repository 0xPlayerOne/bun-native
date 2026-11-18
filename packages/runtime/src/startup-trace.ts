import type { Command, NativeEvent } from '@bun-native/protocol'
import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { redactDiagnostic } from './exit-diagnostic.ts'

const MAX_RECORDS = 256
/** Upper bound for an explicit diagnostic override; the default stays bounded. */
const MAX_RECORDS_LIMIT = 100_000

/**
 * `BUN_NATIVE_STARTUP_TRACE_RECORDS` raises the record cap for a diagnostic run
 * that needs more than the default window — attributing a stall that appears
 * once per thousand updates, for example (#666). It stays bounded and only
 * applies when tracing is already enabled.
 */
function recordCap(): number {
  const raw = process.env['BUN_NATIVE_STARTUP_TRACE_RECORDS']
  if (raw === undefined) return MAX_RECORDS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < MAX_RECORDS || value > MAX_RECORDS_LIMIT)
    throw new Error(`BUN_NATIVE_STARTUP_TRACE_RECORDS must be ${MAX_RECORDS}..${MAX_RECORDS_LIMIT}`)
  return value
}

/** Explicit diagnostic mode only. This is not a request scheduler or transport proxy. */
export class StartupTrace {
  private readonly started = process.hrtime.bigint()
  private records = 0
  private unavailable = false

  private constructor(
    private readonly path: string,
    private readonly nonce: string,
    private readonly maximum = MAX_RECORDS
  ) {}

  static fromEnvironment(): StartupTrace | undefined {
    if (process.env['BUN_NATIVE_STARTUP_TRACE'] !== '1') return
    // `BUN_NATIVE_STARTUP_TRACE_LOG` writes the transport trace on its own path.
    // It exists so a timed workload can be traced without setting the host's
    // `BUN_NATIVE_EVIDENCE_LOG`, which would add per-paint file I/O and perturb
    // the measurement (#666). The evidence log remains the fallback.
    const dedicated = process.env['BUN_NATIVE_STARTUP_TRACE_LOG']
    // `{pid}` keeps one file per launching process. A comparison run starts a new
    // app process per launch, and sharing one path merges their records, which is
    // exactly what obscured the first attribution attempt (#666).
    const path = (dedicated ?? process.env['BUN_NATIVE_EVIDENCE_LOG'])?.replaceAll(
      '{pid}',
      String(process.pid)
    )
    // A dedicated transport path needs no evidence nonce: a timed workload drops
    // every `BUN_NATIVE_EVIDENCE_*` variable on purpose, and requiring one turned
    // an opt-in diagnostic into a launch failure (#666). The evidence-log path
    // keeps the strict binding because its records are qualification evidence.
    const nonce =
      process.env['BUN_NATIVE_EVIDENCE_NONCE'] ?? (dedicated ? 'transport-only' : undefined)
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
    return new StartupTrace(path, nonce, recordCap())
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

  /** `stderr` is the bounded capture; it is recorded redacted, like exit diagnostics. */
  failure(error: Error, stderr: string, clipped: boolean, hostPid: number): void {
    this.write(
      'transport_failed',
      {
        host_pid: hostPid,
        error: error.message.slice(-1_024),
        stderr_tail: redactDiagnostic(stderr, clipped, process.env),
      },
      true
    )
  }

  finished(exitCode: number | null, stderr: string, clipped: boolean, hostPid: number): void {
    this.write(
      'transport_finished',
      {
        host_pid: hostPid,
        exit_code: exitCode,
        stderr_tail: redactDiagnostic(stderr, clipped, process.env),
      },
      true
    )
  }

  private write(phase: string, fields: Record<string, unknown>, terminal = false): void {
    if (this.unavailable || (!terminal && this.records >= this.maximum)) return
    if (!terminal && this.records === this.maximum - 1) {
      phase = 'record_limit'
      fields = { host_pid: fields['host_pid'], maximum_records: this.maximum }
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
