/** Benchmark-owned HTTP entity-body accounting; not an application updater or trust root. */
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { validateByteObservation, type ByteObservation } from './accounting.ts'

export interface ArtifactTransfer {
  readonly category: 'first-run-download' | 'update'
  readonly url: string
  readonly allowedOrigins: readonly string[]
  readonly path: string
  readonly expectedBytes: number
  /** Independently pinned by the caller, never fetched alongside the untrusted artifact. */
  readonly sha256: string
  readonly allowLoopbackHttp?: boolean
  readonly maxRedirects?: number
}
export interface TransferReport {
  readonly schema: 1
  readonly status: 'passed' | 'failed'
  readonly category: ArtifactTransfer['category']
  readonly path: string
  readonly expectedBytes: number
  readonly receivedBytes: number
  readonly expectedSha256: string
  readonly receivedSha256: string | null
  readonly finalOrigin: string | null
  readonly redirects: number
  readonly elapsedMs: number
  readonly errorCode: string | null
  readonly published: boolean
  readonly cleanupEstablished: boolean
  readonly accounting: 'artifact-http-entity-body'
}
const fields = [
  'category',
  'url',
  'allowedOrigins',
  'path',
  'expectedBytes',
  'sha256',
  'allowLoopbackHttp',
  'maxRedirects',
]
const redirectStatuses = new Set([301, 302, 303, 307, 308])
class TransferFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
function deny(code: string): never {
  throw new TransferFailure(code)
}
function address(text: unknown, allowLoopback: boolean): URL {
  if (
    typeof text !== 'string' ||
    !text ||
    text.length > 8192 ||
    Array.from(text).some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\'
    )
  )
    deny('INVALID_TRANSFER_URL')
  let value: URL
  try {
    value = new URL(text)
  } catch {
    return deny('INVALID_TRANSFER_URL')
  }
  if (value.username || value.password || value.hash) deny('INVALID_TRANSFER_URL')
  if (
    value.protocol !== 'https:' &&
    !(
      allowLoopback &&
      value.protocol === 'http:' &&
      (value.hostname === '127.0.0.1' || value.hostname === '[::1]') &&
      value.port
    )
  )
    deny('TRANSFER_PROTOCOL_DENIED')
  return value
}
export function validateArtifactTransfer(input: unknown): ArtifactTransfer {
  if (!input || typeof input !== 'object' || Array.isArray(input)) deny('INVALID_TRANSFER')
  const v = input as Record<string, unknown>
  if (
    Object.keys(v).some((k) => !fields.includes(k)) ||
    typeof v['category'] !== 'string' ||
    !['first-run-download', 'update'].includes(v['category']) ||
    typeof v['sha256'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v['sha256']) ||
    !Number.isSafeInteger(v['expectedBytes']) ||
    Number(v['expectedBytes']) < 1 ||
    Number(v['expectedBytes']) > 16 * 1024 ** 3 ||
    (v['allowLoopbackHttp'] !== undefined && typeof v['allowLoopbackHttp'] !== 'boolean') ||
    (v['maxRedirects'] !== undefined &&
      (!Number.isSafeInteger(v['maxRedirects']) ||
        Number(v['maxRedirects']) < 0 ||
        Number(v['maxRedirects']) > 8))
  )
    deny('INVALID_TRANSFER')
  const path = v['path']
  if (
    typeof path !== 'string' ||
    path.length > 512 ||
    isAbsolute(path) ||
    path
      .split('/')
      .some(
        (part) =>
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) ||
          part.endsWith('.') ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      )
  )
    deny('INVALID_TRANSFER_PATH')
  const loopback = v['allowLoopbackHttp'] === true,
    url = address(v['url'], loopback)
  if (
    !Array.isArray(v['allowedOrigins']) ||
    !v['allowedOrigins'].length ||
    v['allowedOrigins'].length > 16 ||
    new Set(v['allowedOrigins']).size !== v['allowedOrigins'].length
  )
    deny('INVALID_TRANSFER_ORIGINS')
  for (const origin of v['allowedOrigins'])
    if (address(origin, loopback).origin !== origin) deny('INVALID_TRANSFER_ORIGINS')
  if (!v['allowedOrigins'].includes(url.origin)) deny('TRANSFER_ORIGIN_DENIED')
  return structuredClone(input) as ArtifactTransfer
}
/** No query/path text or arbitrary fetch diagnostics enter the report. */
export async function transferArtifact(
  input: unknown,
  options: {
    readonly workspace: string
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  }
): Promise<TransferReport> {
  const plan = validateArtifactTransfer(input),
    timeout = options.timeoutMs ?? 30000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000)
    deny('INVALID_TRANSFER_DEADLINE')
  const started = performance.now(),
    controller = new AbortController()
  let abortCode = 'TRANSFER_CANCELLED'
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    abortCode = 'TRANSFER_DEADLINE'
    abort()
  }, timeout)
  if (options.signal?.aborted) abort()
  const check = () => {
    if (controller.signal.aborted) deny(abortCode)
  }
  let receivedBytes = 0,
    receivedSha256: string | null = null,
    finalOrigin: string | null = null,
    redirects = 0
  let handle: FileHandle | undefined, temporary: string | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let published = false,
    cleanupEstablished = true,
    errorCode: string | null = null
  try {
    check()
    const workspace = await realpath(options.workspace)
    if (!(await lstat(workspace)).isDirectory()) deny('TRANSFER_WORKSPACE_INVALID')
    const target = join(workspace, plan.path)
    let parent = workspace
    for (const part of plan.path.split('/').slice(0, -1)) {
      check()
      parent = join(parent, part)
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const info = await lstat(parent)
      if (!info.isDirectory() || info.isSymbolicLink()) deny('TRANSFER_LINKED_PARENT')
    }
    if (
      await lstat(target).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e
          return false
        }
      )
    )
      deny('TRANSFER_OUTPUT_EXISTS')
    const candidate = join(dirname(target), '.transfer-' + randomBytes(24).toString('hex'))
    handle = await open(candidate, 'wx', 0o600)
    temporary = candidate // Cleanup owns this name only after exclusive creation succeeds.
    let url = address(plan.url, plan.allowLoopbackHttp === true),
      response: Response
    for (;;) {
      check()
      if (!plan.allowedOrigins.includes(url.origin)) deny('TRANSFER_ORIGIN_DENIED')
      finalOrigin = url.origin
      // Preserve system proxy/TLS policy. Never retry using a different origin,
      // identity or disabled certificate checks after an environment denial.
      try {
        response = await fetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'accept-encoding': 'identity' },
          decompress: false,
        })
      } catch {
        check()
        return deny('TRANSFER_REQUEST_FAILED')
      }
      if (response.redirected) deny('TRANSFER_AUTOMATIC_REDIRECT')
      if (!redirectStatuses.has(response.status)) break
      void response.body?.cancel().catch(() => {})
      if (redirects >= (plan.maxRedirects ?? 0)) deny('TRANSFER_REDIRECT_LIMIT')
      const location = response.headers.get('location')
      if (!location) deny('TRANSFER_REDIRECT_INVALID')
      let next: URL
      try {
        next = address(new URL(location, url).href, plan.allowLoopbackHttp === true)
      } catch {
        return deny('TRANSFER_REDIRECT_INVALID')
      }
      if (url.protocol === 'https:' && next.protocol !== 'https:') deny('TRANSFER_DOWNGRADE_DENIED')
      if (!plan.allowedOrigins.includes(next.origin)) deny('TRANSFER_ORIGIN_DENIED')
      redirects++
      url = next
    }
    if (response.status !== 200 || !response.body) {
      void response.body?.cancel().catch(() => {})
      deny('TRANSFER_HTTP_STATUS')
    }
    if (
      response.headers.has('content-range') ||
      (response.headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity'
    ) {
      void response.body.cancel().catch(() => {})
      deny('TRANSFER_ENCODING_DENIED')
    }
    const length = response.headers.get('content-length')
    if (
      length !== null &&
      (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) !== plan.expectedBytes)
    ) {
      void response.body.cancel().catch(() => {})
      deny('TRANSFER_LENGTH_MISMATCH')
    }
    const hash = createHash('sha256')
    reader = response.body.getReader()
    for (;;) {
      check()
      let item: Awaited<ReturnType<NonNullable<typeof reader>['read']>>
      try {
        item = await reader.read()
      } catch {
        check()
        return deny('TRANSFER_BODY_FAILED')
      }
      if (item.done) break
      receivedBytes += item.value.byteLength
      if (receivedBytes > plan.expectedBytes) deny('TRANSFER_BODY_OVERSIZE')
      hash.update(item.value)
      for (let offset = 0; offset < item.value.byteLength;) {
        check()
        const { bytesWritten } = await handle.write(
          item.value,
          offset,
          item.value.byteLength - offset,
          null
        )
        if (bytesWritten < 1) deny('TRANSFER_WRITE_STALLED')
        offset += bytesWritten
      }
    }
    receivedSha256 = hash.digest('hex')
    if (receivedBytes !== plan.expectedBytes) deny('TRANSFER_LENGTH_MISMATCH')
    if (receivedSha256 !== plan.sha256) deny('TRANSFER_HASH_MISMATCH')
    await handle.sync()
    await handle.close()
    handle = undefined
    check()
    // Atomic no-clobber publication in the same directory. Unlike rename(), an
    // intervening creator cannot have its destination silently overwritten.
    await link(temporary, target)
    published = true
    await unlink(temporary)
    temporary = undefined
    check()
  } catch (error) {
    errorCode = error instanceof TransferFailure ? error.code : 'TRANSFER_IO_FAILED'
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
    if (reader) {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    if (handle)
      await handle.close().catch(() => {
        cleanupEstablished = false
      })
    if (temporary)
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') cleanupEstablished = false
      })
  }
  if (!cleanupEstablished && errorCode === null) errorCode = 'TRANSFER_CLEANUP_FAILED'
  return Object.freeze({
    schema: 1,
    status: errorCode === null ? 'passed' : 'failed',
    category: plan.category,
    path: plan.path,
    expectedBytes: plan.expectedBytes,
    receivedBytes,
    expectedSha256: plan.sha256,
    receivedSha256,
    finalOrigin,
    redirects,
    elapsedMs: performance.now() - started,
    errorCode,
    published,
    cleanupEstablished,
    accounting: 'artifact-http-entity-body',
  })
}
/** A valid transfer is separate from a valid first launch or update transaction. */
export function transferBytes(report: TransferReport): ByteObservation {
  if (
    report.status !== 'passed' ||
    !report.published ||
    !report.cleanupEstablished ||
    report.errorCode !== null ||
    report.receivedBytes !== report.expectedBytes ||
    report.receivedSha256 !== report.expectedSha256
  )
    throw new Error('No complete verified artifact transfer')
  return validateByteObservation({
    category: report.category,
    status: 'measured',
    bytes: report.receivedBytes,
    sha256: report.receivedSha256,
    accounting: 'received-body',
    evidence:
      'Directly observed artifact HTTP entity-body, exact length and caller-pinned SHA-256 verified. Excludes redirect bodies, headers, TLS/TCP, retries and unobserved child traffic. Not cache size or proof of app startup/update.',
  })
}
