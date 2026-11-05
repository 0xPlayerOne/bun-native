/** Upper bound for the redacted native stderr tail carried by an exit diagnostic. */
export const MAX_DIAGNOSTIC_TAIL = 2_048
const MAX_DIAGNOSTIC_LINES = 32
const MIN_REDACTED_ENV_VALUE = 6
const REDACTED = '[redacted]'

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
function redactDiagnostic(
  text: string,
  environment: Readonly<Record<string, string | undefined>>
): string {
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

export function exitDiagnostic(input: {
  exitCode: number | null
  signal: string | null
  phase: NativeHostExitDiagnostic['phase']
  pendingRequests: number
  stderr: string
  /** The captured stderr lost its beginning; its first line may be a fragment. */
  stderrClipped: boolean
  environment: Readonly<Record<string, string | undefined>>
}): Readonly<NativeHostExitDiagnostic> {
  // A clipped first line can hold the end of a secret that no longer matches
  // its full environment value, so it is dropped before redaction.
  const stderr = input.stderrClipped
    ? input.stderr.slice(input.stderr.indexOf('\n') + 1 || input.stderr.length)
    : input.stderr
  const redacted = redactDiagnostic(stderr, input.environment)
  const panic = /panicked at ([^\s:]+(?::\d+){2})/.exec(redacted)
  let lines = redacted.trimEnd().split('\n')
  let truncated = input.stderrClipped || lines.length > MAX_DIAGNOSTIC_LINES
  lines = lines.slice(-MAX_DIAGNOSTIC_LINES)
  let tail = lines.join('\n')
  if (tail.length > MAX_DIAGNOSTIC_TAIL) {
    tail = tail.slice(-MAX_DIAGNOSTIC_TAIL)
    truncated = true
  }
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
