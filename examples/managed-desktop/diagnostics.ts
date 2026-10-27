import type { DevelopmentDiagnostic } from '../../packages/cli/src/dev-host.ts'
import {
  ServiceReloadError,
  type ServiceReloadDiagnostic,
} from '../../packages/runtime/src/service-reload.ts'
import type {
  ManagedDiagnosticText,
  ManagedFailureDiagnostic,
  ManagedFailureDiagnostics,
} from './evidence.ts'

const MAX_RECORDS = 32
const MAX_TEXT = 512
type RejectionSource = 'bindings' | 'reload' | 'fixture'

/** Deliberately discard the suffix at a path or credential, including paths with spaces. */
function firstLine(value: string): ManagedDiagnosticText {
  const end = value.search(/[\r\n]/)
  const lineEnd = end < 0 ? value.length : end
  let text = value.slice(0, Math.min(lineEnd, 2048))
  let truncated = text.length < value.length
  let redacted = false
  text = Array.from(text)
    .filter((character) => {
      const code = character.charCodeAt(0)
      const control = code < 32 || (code >= 127 && code <= 159)
      if (control) redacted = true
      return !control
    })
    .join('')
  const sensitive =
    /\b(?:token|nonce|secret|password|authorization|api[-_]?key)\s*(?:[:=]\s*|["'`])|\bbearer\s+/i.exec(
      text
    )
  if (sensitive) {
    text = text.slice(0, sensitive.index) + '[sensitive value omitted]'
    redacted = true
    truncated = true
  }
  text = text.replace(/[A-Za-z0-9_-]{32,}/g, () => {
    redacted = true
    return '[opaque token omitted]'
  })
  const path = /file:\/\/|[A-Za-z]:[\\/]|[\\/]/i.exec(text)
  if (path) {
    text = text.slice(0, path.index) + '[local path omitted]'
    redacted = true
    truncated = true
  }
  if (/^\s*at\s/.test(text)) {
    text = '[stack frame omitted]'
    redacted = true
    truncated = true
  }
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT)
    truncated = true
  }
  return Object.freeze({ text, redacted, truncated })
}

/** Failure-only observer: ordinary 500-replacement stage events are never retained or printed. */
export class ManagedDiagnostics {
  readonly #entries: ManagedFailureDiagnostic[] = []
  #dropped = 0

  #record(entry: ManagedFailureDiagnostic): void {
    if (this.#entries.length === MAX_RECORDS) {
      this.#dropped++
      return
    }
    this.#entries.push(Object.freeze(entry))
  }

  development(event: DevelopmentDiagnostic): void {
    if (event.event !== 'error') return
    this.#record({
      source: 'development',
      event: 'error',
      stage: event.stage,
      code: event.code,
      sequence: event.sequence,
      restartRequired: event.restartRequired,
      message: firstLine(event.message),
    })
  }

  broker(event: ServiceReloadDiagnostic): void {
    if (event.event === 'stage') return
    this.#record({
      source: 'broker',
      event: event.event,
      stage: event.stage,
      generation: event.generation,
      ...(event.code ? { code: event.code } : {}),
      ...(event.restartRequired === undefined ? {} : { restartRequired: event.restartRequired }),
      ...(event.detail ? { detail: firstLine(event.detail) } : {}),
    })
  }

  failure(source: RejectionSource, error: unknown): void {
    // Even an unexpected thrown object/getter must not replace the original rejection.
    try {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      this.#record({
        source,
        event: 'failure',
        stage: error instanceof ServiceReloadError ? error.stage : source,
        ...(typeof code === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(code) ? { code } : {}),
        message: firstLine(error instanceof Error ? error.message : 'Non-Error rejection'),
        ...(error instanceof ServiceReloadError
          ? {
              restartRequired: error.restartRequired,
              candidateRetired: error.candidateRetired,
              committed: error.committed,
              ...(error.detail ? { detail: firstLine(error.detail) } : {}),
            }
          : {}),
      })
    } catch {
      this.#dropped++
    }
  }

  async observe<T>(source: RejectionSource, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      this.failure(source, error)
      throw error
    }
  }

  snapshot(): ManagedFailureDiagnostics {
    return Object.freeze({
      schema: 1,
      entries: Object.freeze([...this.#entries]),
      dropped: this.#dropped,
    })
  }
}
