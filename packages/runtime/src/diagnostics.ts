/** Bounded local diagnostic snapshots. This module opens no debug endpoint. */
import { SourceMap } from 'node:module'
import { isProxy } from 'node:util/types'

export type DiagnosticFrame = {
  readonly file: string
  /** One-based stack-frame coordinates. */
  readonly line: number
  readonly column: number
}

export type DiagnosticRecord = {
  readonly kind: 'bun-error' | 'renderer-log' | 'rpc-stage' | 'reload-stage'
  readonly message: string
  readonly at?: string
  readonly frame?: DiagnosticFrame
}

export type DiagnosticPolicy = {
  /** UTF-8 bytes of the complete JSON bundle, including its envelope; 64..1 MiB. */
  readonly maxBytes: number
  /** Public replacement text, at most 32 UTF-8 bytes without control characters. */
  readonly redaction?: string
}

/** Caller-supplied v3 map, bound to the exact generated file; no implicit map lookup or I/O. */
export type DiagnosticSourceMap = {
  readonly version: 3
  readonly file: string
  readonly sources: readonly string[]
  readonly names?: readonly string[]
  readonly mappings: string
  readonly sourceRoot?: string
}

export type DiagnosticBundle = {
  readonly records: readonly DiagnosticRecord[]
  readonly bytes: number
  readonly truncated: boolean
}

const MAX_BYTES = 1024 * 1024
const MAX_RECORDS = 256
const MAX_TEXT = 8192
const MAX_DEPTH = 8
const MAX_NODES = 256
const MAX_MAP_ITEMS = 4096
const KINDS = new Set(['bun-error', 'renderer-log', 'rpc-stage', 'reload-stage'])
const SECRET_PATTERN = /(token|nonce|secret|password|passwd|api[_-]?key|authorization|credential)/i
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i
const HOME_PATTERN =
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\r\n]+\/?|(?:file:\/\/)?\/root(?:\/|$)|(?:file:\/\/\/)?[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n]+[\\/]*/gi
const OMITTED = '[unavailable]'
const TRUNCATED = '[truncated]'

function control(character: string): boolean {
  const code = character.charCodeAt(0)
  return code < 32 || (code >= 127 && code <= 159)
}

/** Read own data properties only: diagnostic collection must not call application code. */
function data(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function policySnapshot(policy: DiagnosticPolicy): Required<DiagnosticPolicy> {
  if (!plain(policy)) throw new TypeError('Diagnostic policy must be a plain data object')
  const maxBytes = data(policy, 'maxBytes')
  const redaction = data(policy, 'redaction') ?? '[redacted]'
  if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 64 || Number(maxBytes) > MAX_BYTES)
    throw new TypeError('Diagnostic maxBytes must be an integer from 64 through 1048576')
  if (
    typeof redaction !== 'string' ||
    !redaction.length ||
    Buffer.byteLength(redaction, 'utf8') > 32 ||
    Array.from(redaction).some(control)
  )
    throw new TypeError('Diagnostic redaction must be public, bounded text')
  return { maxBytes: Number(maxBytes), redaction }
}

function text(value: string, redaction: string): { value: string; truncated: boolean } {
  // Reject oversized strings as a unit: do not return a possibly partial secret assignment.
  if (value.length > MAX_TEXT || Buffer.byteLength(value, 'utf8') > MAX_TEXT)
    return { value: TRUNCATED, truncated: true }
  const cleaned = Array.from(value)
    .filter((character) => !control(character) || ['\t', '\n', '\r'].includes(character))
    .join('')
  if (SECRET_PATTERN.test(cleaned) || CREDENTIAL_URL.test(cleaned))
    return { value: redaction, truncated: false }
  return { value: cleaned.replace(HOME_PATTERN, '~/'), truncated: false }
}

/**
 * Snapshot JSON-like values without accessors, toJSON, proxy traps or custom iterators.
 * Cycles, unsupported values and bounded traversal cutoffs receive explicit markers.
 */
export function redactDiagnosticValue(value: unknown, policy: DiagnosticPolicy): unknown {
  const checked = policySnapshot(policy)
  const ancestors = new WeakSet<object>()
  let nodes = 0
  const visit = (entry: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return TRUNCATED
    if (entry === null || typeof entry === 'boolean') return entry
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : OMITTED
    if (typeof entry === 'string') return text(entry, checked.redaction).value
    if (!entry || typeof entry !== 'object' || isProxy(entry)) return OMITTED
    if (ancestors.has(entry)) return '[circular]'
    if (!Array.isArray(entry) && !plain(entry)) return OMITTED
    ancestors.add(entry)
    try {
      if (Array.isArray(entry)) {
        const result: unknown[] = []
        for (let index = 0; index < entry.length; index++) {
          if (nodes >= MAX_NODES) {
            result.push(TRUNCATED)
            break
          }
          result.push(visit(data(entry, String(index)), depth + 1))
        }
        return result
      }
      const result: Record<string, unknown> = Object.create(null)
      for (const key in entry) {
        if (!Object.hasOwn(entry, key)) continue
        if (nodes >= MAX_NODES) {
          result['[omitted fields]'] = TRUNCATED
          break
        }
        const name = text(key, checked.redaction)
        const secret =
          SECRET_PATTERN.test(key) || name.value === checked.redaction || name.truncated
        result[name.value] = secret ? checked.redaction : visit(data(entry, key), depth + 1)
        // Secret-named entries do not recurse, but still consume the traversal budget.
        if (secret) nodes++
      }
      return result
    } finally {
      ancestors.delete(entry)
    }
  }
  const result = visit(value, 0)
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= checked.maxBytes ? result : TRUNCATED
}

function frameSnapshot(value: unknown): DiagnosticFrame | undefined {
  if (!plain(value)) return undefined
  const file = data(value, 'file'),
    line = data(value, 'line'),
    column = data(value, 'column')
  if (
    typeof file !== 'string' ||
    !file.length ||
    file.length > MAX_TEXT ||
    !Number.isSafeInteger(line) ||
    Number(line) < 1 ||
    !Number.isSafeInteger(column) ||
    Number(column) < 1
  )
    return undefined
  return Object.freeze({ file, line: Number(line), column: Number(column) })
}

function sourceMapper(
  value: DiagnosticSourceMap | undefined
): (frame: DiagnosticFrame) => DiagnosticFrame {
  const unchanged = (frame: DiagnosticFrame) => frame
  if (!plain(value)) return unchanged
  const file = data(value, 'file'),
    version = data(value, 'version'),
    mappings = data(value, 'mappings')
  const sourceRoot = data(value, 'sourceRoot') ?? ''
  if (
    version !== 3 ||
    typeof file !== 'string' ||
    !file.length ||
    file.length > MAX_TEXT ||
    typeof sourceRoot !== 'string' ||
    sourceRoot.length > MAX_TEXT ||
    typeof mappings !== 'string' ||
    !mappings.length ||
    mappings.length > MAX_BYTES ||
    !/^[A-Za-z0-9+/;,]+$/.test(mappings)
  )
    return unchanged
  let bytes = Buffer.byteLength(file + sourceRoot + mappings, 'utf8')
  const strings = (candidate: unknown): string[] | undefined => {
    if (!Array.isArray(candidate) || isProxy(candidate) || candidate.length > MAX_MAP_ITEMS)
      return undefined
    const result: string[] = []
    for (let index = 0; index < candidate.length; index++) {
      const entry = data(candidate, String(index))
      if (typeof entry !== 'string' || entry.length > MAX_TEXT) return undefined
      bytes += Buffer.byteLength(entry, 'utf8')
      if (bytes > MAX_BYTES) return undefined
      result.push(entry)
    }
    return result
  }
  const sources = strings(data(value, 'sources'))
  const names = strings(data(value, 'names') ?? [])
  if (!sources?.length || !names || bytes > MAX_BYTES) return unchanged
  try {
    const map = new SourceMap({
      file,
      version,
      mappings,
      sourceRoot,
      sources,
      names,
      sourcesContent: [],
    })
    return (frame) => {
      if (frame.file !== file) return frame
      try {
        const entry = map.findEntry(frame.line - 1, frame.column - 1)
        // Use the actual mapped segment, not an extrapolated location on an unmapped line.
        if (!('generatedLine' in entry) || entry.generatedLine !== frame.line - 1) return frame
        return (
          frameSnapshot({
            file: entry.originalSource,
            line: entry.originalLine + 1,
            column: entry.originalColumn + 1,
          }) ?? frame
        )
      } catch {
        return frame
      }
    }
  } catch {
    return unchanged
  }
}

/** Resolve a real v3 segment with Bun's node:module implementation; unusable maps preserve the capture. */
export function renderSourceMappedFrame(
  frame: DiagnosticFrame,
  sourceMap: DiagnosticSourceMap | undefined
): DiagnosticFrame {
  const captured = frameSnapshot(frame)
  if (!captured) throw new TypeError('Invalid diagnostic stack frame')
  return sourceMapper(sourceMap)(captured)
}

function bundleBytes(recordBytes: number, truncated: boolean): number {
  const envelope = Buffer.byteLength(
    '{"records":[],"bytes":,"truncated":' + truncated + '}',
    'utf8'
  )
  let bytes = envelope + recordBytes + 1
  for (;;) {
    const next = envelope + recordBytes + String(bytes).length
    if (next === bytes) return bytes
    bytes = next
  }
}

/** Admit an immutable prefix under bounded input work and exact complete-envelope byte accounting. */
export function collectDiagnosticBundle(
  records: readonly DiagnosticRecord[],
  policy: DiagnosticPolicy,
  sourceMap?: DiagnosticSourceMap
): DiagnosticBundle {
  const checked = policySnapshot(policy)
  if (!Array.isArray(records) || isProxy(records))
    throw new TypeError('Diagnostic records must be an ordinary array')
  const map = sourceMapper(sourceMap)
  const kept: DiagnosticRecord[] = []
  let contentBytes = 0,
    truncated = records.length > MAX_RECORDS
  for (let index = 0; index < Math.min(records.length, MAX_RECORDS); index++) {
    const input = data(records, String(index))
    if (!plain(input)) {
      truncated = true
      continue
    }
    const kind = data(input, 'kind'),
      message = data(input, 'message')
    if (typeof kind !== 'string' || !KINDS.has(kind) || typeof message !== 'string') {
      truncated = true
      continue
    }
    const sanitized = text(message, checked.redaction)
    truncated ||= sanitized.truncated
    const at = data(input, 'at')
    const frame = frameSnapshot(data(input, 'frame'))
    if (
      (Object.hasOwn(input, 'at') && typeof at !== 'string') ||
      (Object.hasOwn(input, 'frame') && !frame)
    )
      truncated = true
    const stamp = typeof at === 'string' ? text(at, checked.redaction) : undefined
    const mapped = frame ? map(frame) : undefined
    const location = mapped ? text(mapped.file, checked.redaction) : undefined
    truncated ||= stamp?.truncated === true || location?.truncated === true
    const record: DiagnosticRecord = Object.freeze({
      kind: kind as DiagnosticRecord['kind'],
      message: sanitized.value,
      ...(stamp ? { at: stamp.value } : {}),
      ...(mapped && location ? { frame: Object.freeze({ ...mapped, file: location.value }) } : {}),
    })
    const added = Buffer.byteLength(JSON.stringify(record), 'utf8') + (kept.length ? 1 : 0)
    // Reserve the larger false envelope even if a later omitted input changes truncated to true.
    if (bundleBytes(contentBytes + added, false) > checked.maxBytes) {
      truncated = true
      break
    }
    kept.push(record)
    contentBytes += added
  }
  return Object.freeze({
    records: Object.freeze(kept),
    bytes: bundleBytes(contentBytes, truncated),
    truncated,
  })
}
