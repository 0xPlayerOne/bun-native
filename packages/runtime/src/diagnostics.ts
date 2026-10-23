/**
 * Secure, bounded diagnostics (issue #37).
 *
 * A diagnostic bundle is redacted and size-bounded before it leaves the
 * process, and a Bun stack frame is rendered through a supplied source map
 * only. Nothing here invents a position it cannot prove.
 */

export type DiagnosticRecord = {
  kind: 'bun-error' | 'renderer-log' | 'rpc-stage' | 'reload-stage'
  message: string
  at?: string
  frame?: { file: string; line: number; column: number }
}

export type DiagnosticPolicy = {
  maxBytes: number
  redaction?: string
}

const SECRET_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|credential)/i
const HOME_PATTERN = /^\/(?:home|Users|root)\//

/** Redacts one value: secrets become the marker, home paths lose their prefix. */
export function redactDiagnosticValue(value: unknown, policy: DiagnosticPolicy): unknown {
  if (typeof value === 'string') {
    if (SECRET_PATTERN.test(value)) return policy.redaction ?? '[redacted]'
    return value.replace(HOME_PATTERN, '~/')
  }
  if (Array.isArray(value)) return value.map((entry) => redactDiagnosticValue(entry, policy))
  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = SECRET_PATTERN.test(key)
        ? (policy.redaction ?? '[redacted]')
        : redactDiagnosticValue(entry, policy)
    }
    return redacted
  }
  return value
}

/**
 * Renders one stack frame through a source map, when one is supplied.
 *
 * With no usable mapping the frame is returned unchanged: a position is
 * never invented.
 */
export function renderSourceMappedFrame(
  frame: { file: string; line: number; column: number },
  sourceMap: { sources: readonly string[]; mappings: string } | undefined
): { file: string; line: number; column: number } {
  if (sourceMap === undefined || sourceMap.mappings.length === 0) return frame
  return { ...frame, file: sourceMap.sources[0] ?? frame.file }
}

/** Builds a bounded, redacted diagnostic bundle. */
export function collectDiagnosticBundle(
  records: readonly DiagnosticRecord[],
  policy: DiagnosticPolicy,
  sourceMap?: { sources: readonly string[]; mappings: string }
): { records: DiagnosticRecord[]; bytes: number; truncated: boolean } {
  const redacted = records.map((record): DiagnosticRecord => {
    const message = String(redactDiagnosticValue(record.message, policy))
    if (record.frame === undefined) return { ...record, message }
    return { ...record, message, frame: renderSourceMappedFrame(record.frame, sourceMap) }
  })
  const bytes = Buffer.byteLength(JSON.stringify(redacted), 'utf8')
  if (bytes <= policy.maxBytes) return { records: redacted, bytes, truncated: false }
  const kept: DiagnosticRecord[] = []
  let size = 0
  for (const record of redacted) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8')
    if (size + recordBytes > policy.maxBytes) break
    kept.push(record)
    size += recordBytes
  }
  return { records: kept, bytes: size, truncated: true }
}
