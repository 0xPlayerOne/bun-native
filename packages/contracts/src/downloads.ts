import { BunlyError } from './core.ts'
import type { OperationOptions, ViewHandle } from './index.ts'

/** The application chooses a destination under an already granted native root. */
export interface DownloadDestination {
  readonly root: string
  /** A single portable filename, never a renderer-provided absolute path. */
  readonly name: string
  readonly overwrite: 'deny' | 'replace'
}
export interface ScopedDownloadRequest {
  readonly url: string
  readonly destination: DownloadDestination
  /** Final size ceiling. Native updates trigger cancellation above it; this is not a disk quota. */
  readonly maxBytes?: number
  /** Total transfer lifetime; cancellation has a separate native settlement bound. */
  readonly timeoutMs?: number
}
export type DownloadFailure = 'network' | 'destination' | 'permission' | 'limit' | 'timeout'
export interface DownloadProgress {
  readonly status: 'starting' | 'in-progress' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  /** Observed native transfer bytes. These are not committed destination bytes. */
  readonly bytesReceived: number
  /** null means the server has not supplied a known total. */
  readonly totalBytes: number | null
  readonly failure: DownloadFailure | null
}
export type DownloadOutcome =
  | {
      readonly status: 'completed'
      readonly bytesWritten: number
      readonly bytesReceived: number
    }
  | {
      readonly status: 'cancelled'
      readonly bytesWritten: 0
      readonly bytesReceived: number
    }
  | {
      readonly status: 'failed'
      readonly bytesWritten: 0
      readonly bytesReceived: number
      readonly failure: DownloadFailure
    }
/** An operation retains its native reservation until completion or native cancellation settles. */
export interface DownloadOperation {
  readonly completed: Promise<DownloadOutcome>
  state(): DownloadProgress
  /** Resolves only after terminal native settlement and owned temporary-file cleanup. */
  cancel(): Promise<DownloadOutcome>
  onProgress(listener: (progress: DownloadProgress) => void): () => void
}
/** Optional additive facet. Test download.manage before invoking it. */
export interface DownloadManagementBackend {
  startDownload(
    view: ViewHandle,
    request: ScopedDownloadRequest,
    options?: OperationOptions
  ): Promise<DownloadOperation>
}
export interface NormalizedDownloadRequest {
  readonly url: string
  readonly destination: DownloadDestination
  readonly maxBytes: number
  readonly timeoutMs: number
}
export const DOWNLOAD_LIMITS = Object.freeze({
  operations: 8,
  listeners: 32,
  defaultMaxBytes: 64 * 1024 * 1024,
  maxBytes: 1024 * 1024 * 1024,
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 300_000,
} as const)
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BunlyError('INVALID_ARGUMENT', 'Expected a download options object')
  return value as Record<string, unknown>
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new BunlyError('INVALID_ARGUMENT', 'Download limit is outside its supported bounds')
  return Number(value)
}
function asciiControl(value: string, includeSpace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= (includeSpace ? 32 : 31) || code === 127) return true
  }
  return false
}
export function isPortableDownloadName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
    !value.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
}
export function normalizeDownloadRequest(value: unknown): NormalizedDownloadRequest {
  const input = object(value)
  if (
    Object.keys(input).some((key) => !['url', 'destination', 'maxBytes', 'timeoutMs'].includes(key))
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Unknown download option')
  if (
    typeof input['url'] !== 'string' ||
    input['url'].length > 4000 ||
    asciiControl(input['url'], true)
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid download URL')
  let url: URL
  try {
    url = new URL(input['url'])
  } catch {
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid download URL')
  }
  if (
    url.href.length > 4000 ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol === 'http:' && (url.hostname !== '127.0.0.1' || !url.port))
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Downloads require HTTPS or an exact loopback URL')
  const destination = object(input['destination'])
  if (
    Object.keys(destination).length !== 3 ||
    typeof destination['root'] !== 'string' ||
    !destination['root'].length ||
    destination['root'].length > 4096 ||
    !(destination['root'].startsWith('/') || /^[A-Za-z]:[\\/]/.test(destination['root'])) ||
    destination['root'].startsWith('//') ||
    destination['root'].startsWith('\\\\') ||
    asciiControl(destination['root']) ||
    !isPortableDownloadName(destination['name']) ||
    !['deny', 'replace'].includes(String(destination['overwrite']))
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Choose an explicit scoped download destination')
  return Object.freeze({
    url: url.href,
    destination: Object.freeze({
      root: destination['root'],
      name: destination['name'],
      overwrite: destination['overwrite'] as DownloadDestination['overwrite'],
    }),
    maxBytes: integer(
      input['maxBytes'] ?? DOWNLOAD_LIMITS.defaultMaxBytes,
      1,
      DOWNLOAD_LIMITS.maxBytes
    ),
    timeoutMs: integer(
      input['timeoutMs'] ?? DOWNLOAD_LIMITS.defaultTimeoutMs,
      1000,
      DOWNLOAD_LIMITS.maxTimeoutMs
    ),
  })
}
export function parseDownloadProgress(value: unknown): DownloadProgress {
  const data = object(value)
  const status = data['status']
  const failure = data['failure']
  if (
    Object.keys(data).length !== 4 ||
    !['starting', 'in-progress', 'cancelling', 'completed', 'cancelled', 'failed'].includes(
      String(status)
    ) ||
    (failure !== null &&
      !['network', 'destination', 'permission', 'limit', 'timeout'].includes(String(failure))) ||
    (status === 'failed') !== (failure !== null)
  )
    throw new Error('Invalid native download progress')
  const bytesReceived = integer(data['bytesReceived'], 0, Number.MAX_SAFE_INTEGER)
  const totalBytes =
    data['totalBytes'] === null ? null : integer(data['totalBytes'], 0, Number.MAX_SAFE_INTEGER)
  return Object.freeze({
    status: status as DownloadProgress['status'],
    bytesReceived,
    totalBytes,
    failure: failure as DownloadFailure | null,
  })
}
