/** Upper bound for the redacted native stderr tail carried by an exit diagnostic. */
export const MAX_DIAGNOSTIC_TAIL = 2_048
const MAX_DIAGNOSTIC_LINES = 32
const MIN_REDACTED_ENV_VALUE = 6
const REDACTED = '[redacted]'
const CLIPPED = '…'
const PANIC_LOCATION = /panicked at ([^\s:]+(?::\d+){2})/

export type NativeHostExitReason = 'panic' | 'signal' | 'exit'

/**
 * Bounded record of an unexpected native host exit. It never carries the
 * environment, command line or unredacted native output, so it is safe to log.
 */
export interface NativeHostExitDiagnostic {
  readonly reason: NativeHostExitReason
  /** Process exit code, or null when the host was terminated by a signal. */
  readonly exitCode: number | null
  readonly signal: string | null
  /** Transport phase when the host exited. */
  readonly phase: 'starting' | 'running' | 'stopping'
  /** Requests that were awaiting acknowledgement and were rejected with this error. */
  readonly pendingRequests: number
  /** `file:line:column` of a Rust panic reported on stderr, if any. */
  readonly panicLocation: string | null
  /** Redacted last native stderr lines, at most MAX_DIAGNOSTIC_TAIL characters. */
  readonly stderrTail: string
  readonly stderrTruncated: boolean
}

export class NativeHostExitError extends Error {
  override readonly name = 'NativeHostExitError'
  constructor(
    readonly diagnostic: Readonly<NativeHostExitDiagnostic>,
    status: number
  ) {
    super(`Native host exited unexpectedly (${status}). ${diagnostic.stderrTail}`)
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Removes inherited environment values, assignments and credential-shaped
 * tokens from native output. Over-redaction is acceptable; leaks are not.
 */
function redact(text: string, environment: Readonly<Record<string, string | undefined>>): string {
  let redacted = text.replace(/\p{Cc}/gu, (control) =>
    control === '\n' || control === '\t' ? control : ''
  )
  const values = [
    ...new Set(
      Object.values(environment).filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length >= MIN_REDACTED_ENV_VALUE
      )
    ),
  ].sort((left, right) => right.length - left.length)
  for (const value of values)
    redacted = redacted.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED)
  return redacted
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, `$1=${REDACTED}`)
    .replace(
      /\b(authorization|bearer|token|secret|password|passwd|api[_-]?key|cookie)(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi,
      `$1$2${REDACTED}`
    )
    .replace(/\b[A-Za-z0-9+_-]{32,}={0,2}/g, REDACTED)
}

/**
 * Captured native stderr, safe to log or record. A clipped first line can hold
 * the end of a secret that no longer matches its full environment value, so it
 * is dropped before redaction.
 */
export function redactDiagnostic(
  stderr: string,
  clipped: boolean,
  environment: Readonly<Record<string, string | undefined>>
): string {
  return redact(
    clipped ? stderr.slice(stderr.indexOf('\n') + 1 || stderr.length) : stderr,
    environment
  )
}

export function exitDiagnostic(input: {
  exitCode: number | null
  signal: string | null
  phase: NativeHostExitDiagnostic['phase']
  pendingRequests: number
  stderr: string
  /** The captured stderr lost its beginning; its first line may be a fragment. */
  stderrClipped: boolean
  /**
   * Complete `panicked at` header and message lines kept while stderr was
   * captured, so a long backtrace that clips the bounded capture cannot hide
   * the panic itself.
   */
  panicReport?: string | null
  environment: Readonly<Record<string, string | undefined>>
}): Readonly<NativeHostExitDiagnostic> {
  const redacted = redactDiagnostic(input.stderr, input.stderrClipped, input.environment)
  let panic = PANIC_LOCATION.exec(redacted)
  // The kept report leads the tail only when the captured stderr lost it.
  const report =
    !panic && input.panicReport
      ? redact(input.panicReport, input.environment)
          .trimEnd()
          .slice(0, MAX_DIAGNOSTIC_TAIL / 2)
      : null
  if (report) panic = PANIC_LOCATION.exec(report)
  const reportLines = report ? [...report.split('\n'), CLIPPED] : []
  let lines = redacted.trimEnd().split('\n')
  const room = MAX_DIAGNOSTIC_LINES - reportLines.length
  let truncated = input.stderrClipped || lines.length > room
  lines = lines.slice(-room)
  let tail = lines.join('\n')
  const tailRoom = MAX_DIAGNOSTIC_TAIL - (report ? report.length + CLIPPED.length + 2 : 0)
  if (tail.length > tailRoom) {
    tail = tail.slice(-tailRoom)
    truncated = true
  }
  if (report) tail = [...reportLines, tail].join('\n')
  return Object.freeze({
    reason: panic ? 'panic' : input.signal ? 'signal' : 'exit',
    exitCode: input.exitCode,
    signal: input.signal,
    phase: input.phase,
    pendingRequests: input.pendingRequests,
    panicLocation: panic?.[1] ?? null,
    stderrTail: tail,
    stderrTruncated: truncated,
  })
}
