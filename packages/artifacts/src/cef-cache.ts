/** Streaming complete-CEF acquisition. Never compiles, executes, or silently substitutes a runtime. */
import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  type FileHandle,
} from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createGunzip } from 'node:zlib'
import {
  cefError,
  verifyCefManifest,
  type CefMember,
  type CefRuntimeIdentity,
  type CefRuntimeManifest,
} from './cef-manifest.ts'
import type { SignedManifest } from './manifest.ts'
import { kernelLock } from './kernel-lock.ts'
export interface CefResolveOptions {
  readonly envelope: SignedManifest
  readonly trustRoots: Readonly<Record<string, string>>
  readonly expected: CefRuntimeIdentity
  readonly cacheRoot: string
  readonly allowedOrigins: readonly string[]
  readonly offline?: boolean
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly reserveBytes?: number
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>
}
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code
async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (e) {
    if (code(e) === 'ENOENT') return false
    throw e
  }
}
function operation(options: Pick<CefResolveOptions, 'signal' | 'timeoutMs'>) {
  const timeout = options.timeoutMs ?? 120000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000)
    cefError('INVALID_ARGUMENT', 'Invalid runtime acquisition deadline')
  const limit = AbortSignal.timeout(timeout)
  return options.signal ? AbortSignal.any([options.signal, limit]) : limit
}
async function rootDirectory(path: string) {
  const p = resolve(path)
  await mkdir(p, { recursive: true, mode: 0o700 })
  const st = await lstat(p)
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((st.mode & 0o022) !== 0 || (process.getuid && st.uid !== process.getuid())))
  )
    cefError('UNSAFE_CACHE', 'Runtime cache must be a private owned directory')
  return realpath(p)
}
async function writeAll(file: FileHandle, bytes: Uint8Array, signal: AbortSignal) {
  let offset = 0
  while (offset < bytes.length) {
    signal.throwIfAborted()
    const n = await file.write(bytes, offset, bytes.length - offset)
    if (!n.bytesWritten) cefError('WRITE_FAILED', 'No progress writing runtime')
    offset += n.bytesWritten
  }
}
async function hashFile(
  path: string,
  expected: Extract<CefMember, { type: 'file' }>,
  signal: AbortSignal
) {
  const first = await lstat(path)
  if (
    !first.isFile() ||
    first.isSymbolicLink() ||
    first.nlink !== 1 ||
    first.size !== expected.size ||
    (process.platform !== 'win32' && (first.mode & 0o777) !== expected.mode)
  )
    cefError('INTEGRITY_ERROR', 'Runtime member metadata differs from manifest')
  const f = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(65536)
  let size = 0
  try {
    const actual = await f.stat()
    if (actual.ino !== first.ino || actual.dev !== first.dev)
      cefError('UNSAFE_CACHE', 'Runtime member changed during open')
    for (;;) {
      signal.throwIfAborted()
      const { bytesRead } = await f.read(
        buffer,
        0,
        Math.min(buffer.length, expected.size - size + 1),
        null
      )
      if (!bytesRead) break
      size += bytesRead
      if (size > expected.size) cefError('INTEGRITY_ERROR', 'Runtime file grew')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await f.stat()
    if (
      size !== expected.size ||
      after.size !== size ||
      after.nlink !== 1 ||
      hash.digest('hex') !== expected.sha256
    )
      cefError('INTEGRITY_ERROR', `Corrupt runtime member: ${expected.path}`)
  } finally {
    await f.close()
  }
}
export async function validateCefDirectory(
  root: string,
  manifest: CefRuntimeManifest,
  signal: AbortSignal
): Promise<void> {
  const st = await lstat(root)
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (process.platform !== 'win32' && (st.mode & 0o022) !== 0)
  )
    cefError('UNSAFE_CACHE', 'Invalid cached runtime root')
  const canonical = await realpath(root),
    members = new Map(manifest.members.map((f) => [f.path, f]))
  const pending = ['']
  let found = 0
  while (pending.length) {
    const prefix = pending.pop()!
    for await (const entry of await opendir(join(root, prefix))) {
      signal.throwIfAborted()
      const name = prefix ? prefix + '/' + entry.name : entry.name,
        expected = members.get(name)
      if (!expected) cefError('INTEGRITY_ERROR', 'Unlisted runtime member')
      const path = join(root, name),
        info = await lstat(path)
      found++
      if (expected.type === 'directory') {
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (process.platform !== 'win32' && (info.mode & 0o777) !== expected.mode)
        )
          cefError('INTEGRITY_ERROR', 'Invalid runtime directory')
        pending.push(name)
      } else if (expected.type === 'file') await hashFile(path, expected, signal)
      else {
        if (!info.isSymbolicLink() || (await readlink(path)) !== expected.target)
          cefError('INTEGRITY_ERROR', 'Invalid cached runtime link')
        const dest = await realpath(path)
        if (!dest.startsWith(canonical + sep))
          cefError('UNSAFE_CACHE', 'Runtime link escaped cache')
      }
    }
  }
  if (found !== members.size) cefError('INTEGRITY_ERROR', 'Incomplete cached runtime')
  const config = JSON.parse(
    await readFile(join(root, manifest.layout.resources, 'runtime.json'), 'utf8')
  ) as Record<string, unknown>
  if (
    !config ||
    Array.isArray(config) ||
    Object.keys(config).sort().join('|') !== 'bun_version|cef_version|protocol|schema' ||
    config['schema'] !== 1 ||
    config['protocol'] !== manifest.identity.abi ||
    config['bun_version'] !== manifest.identity.bun ||
    config['cef_version'] !== manifest.identity.cef
  )
    cefError(
      'IDENTITY_MISMATCH',
      'Cached runtime enables development or differs from its signed identity'
    )
}
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void = () => {}
): Promise<T> {
  return new Promise((ok, bad) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      onAbort()
      bad(signal.reason)
    }
    promise.then(
      (v) => {
        signal.removeEventListener('abort', abort)
        ok(v)
      },
      (e) => {
        signal.removeEventListener('abort', abort)
        bad(e)
      }
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
async function download(
  path: string,
  manifest: CefRuntimeManifest,
  options: CefResolveOptions,
  signal: AbortSignal
) {
  const fetcher = options.fetcher ?? fetch
  let url = new URL(manifest.archive.url)
  for (let hop = 0; hop <= 3; hop++) {
    signal.throwIfAborted()
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !options.allowedOrigins.includes(url.origin)
    )
      cefError('UNTRUSTED_ORIGIN', 'CEF artifact origin denied')
    const res = await abortable(
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted()
          return fetcher(url.href, {
            redirect: 'manual',
            credentials: 'omit',
            headers: { 'accept-encoding': 'identity' },
            signal,
          })
        })
        .then((r) => {
          if (signal.aborted) {
            void r.body?.cancel().catch(() => {})
            signal.throwIfAborted()
          }
          return r
        }),
      signal
    )
    const cancel = () => {
      void res.body?.cancel().catch(() => {})
    }
    if (res.redirected) {
      cancel()
      cefError('UNTRUSTED_ORIGIN', 'Runtime download bypassed redirect checks')
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location')
      cancel()
      if (!location) cefError('DOWNLOAD_FAILED', 'Missing runtime redirect')
      url = new URL(location, url)
      continue
    }
    if (res.status !== 200 || !res.body) {
      cancel()
      cefError('DOWNLOAD_FAILED', 'Runtime archive download failed')
    }
    const length = res.headers.get('content-length'),
      encoding = res.headers.get('content-encoding')
    if (
      (length !== null && (!/^\d+$/.test(length) || Number(length) !== manifest.archive.size)) ||
      (encoding !== null && encoding !== 'identity')
    ) {
      cancel()
      cefError('INTEGRITY_ERROR', 'Unexpected transport encoding/length')
    }
    const reader = res.body.getReader(),
      file = await open(path, 'wx', 0o600),
      hash = createHash('sha256')
    let size = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const next = await abortable(reader.read(), signal, () => {
          void reader.cancel().catch(() => {})
        })
        if (next.done) break
        size += next.value.length
        if (size > manifest.archive.size)
          cefError('INTEGRITY_ERROR', 'Runtime exceeds signed archive length')
        hash.update(next.value)
        await writeAll(file, next.value, signal)
      }
      if (size !== manifest.archive.size || hash.digest('hex') !== manifest.archive.sha256)
        cefError('INTEGRITY_ERROR', 'Runtime archive hash/length mismatch')
      await file.sync()
      return
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
      await file.close()
    }
  }
  cefError('DOWNLOAD_FAILED', 'Too many runtime archive redirects')
}
class Blocks {
  #iterator: AsyncIterator<Buffer>
  #chunk: Buffer = Buffer.alloc(0)
  #offset = 0
  received = 0
  constructor(
    source: AsyncIterable<Buffer>,
    readonly limit: number,
    readonly signal: AbortSignal
  ) {
    this.#iterator = source[Symbol.asyncIterator]()
  }
  async read(size: number, optional = false): Promise<Buffer | null> {
    const out = Buffer.alloc(size)
    let done = 0
    while (done < size) {
      this.signal.throwIfAborted()
      if (this.#offset === this.#chunk.length) {
        const next = await this.#iterator.next()
        if (next.done) {
          if (optional && done === 0) return null
          cefError('BAD_ARCHIVE', 'Truncated CEF archive')
        }
        this.#chunk = next.value
        this.#offset = 0
        this.received += next.value.length
        if (this.received > this.limit)
          cefError('BAD_ARCHIVE', 'Expanded CEF archive exceeds signed size')
      }
      const count = Math.min(size - done, this.#chunk.length - this.#offset)
      out.set(this.#chunk.subarray(this.#offset, this.#offset + count), done)
      this.#offset += count
      done += count
    }
    return out
  }
}
const octal = (field: Buffer) => {
  const text = field.toString('ascii').replace(/\0.*$/, '').trim()
  if (!/^[0-7]+$/.test(text)) cefError('BAD_ARCHIVE', 'Invalid tar integer')
  const n = parseInt(text, 8)
  if (!Number.isSafeInteger(n)) cefError('BAD_ARCHIVE', 'Tar integer overflow')
  return n
}
const field = (b: Buffer) => {
  const n = b.indexOf(0)
  if (n >= 0 && b.subarray(n).some((v) => v !== 0)) cefError('BAD_ARCHIVE', 'Noncanonical tar text')
  return new TextDecoder('utf-8', { fatal: true }).decode(n < 0 ? b : b.subarray(0, n))
}
async function extract(
  archive: string,
  destination: string,
  manifest: CefRuntimeManifest,
  signal: AbortSignal
) {
  await mkdir(destination, { mode: 0o700 })
  const expected = new Map(manifest.members.map((f) => [f.path, f])),
    seen = new Set<string>()
  for (const f of manifest.members
    .filter((f) => f.type === 'directory')
    .sort((a, b) => a.path.length - b.path.length)) {
    const mode = (f as Extract<CefMember, { type: 'directory' }>).mode
    await mkdir(join(destination, f.path), { mode })
    await chmod(join(destination, f.path), mode)
  }
  const source = createReadStream(archive, { highWaterMark: 65536 }),
    gzip = createGunzip({ chunkSize: 65536 })
  const abort = () => {
    source.destroy(new Error('CEF extraction cancelled'))
    gzip.destroy(new Error('CEF extraction cancelled'))
  }
  source.on('error', (e) => gzip.destroy(e))
  gzip.on('error', () => {})
  signal.addEventListener('abort', abort, { once: true })
  source.pipe(gzip)
  const blocks = new Blocks(gzip, manifest.archive.tarBytes, signal)
  try {
    for (;;) {
      const header = (await blocks.read(512))!
      if (header.every((v) => v === 0)) {
        if (!(await blocks.read(512))!.every((v) => v === 0))
          cefError('BAD_ARCHIVE', 'Missing tar terminator')
        break
      }
      if (
        header.subarray(257, 263).toString('ascii') !== 'ustar\0' ||
        header.subarray(263, 265).toString('ascii') !== '00'
      )
        cefError('BAD_ARCHIVE', 'Only strict USTAR is supported')
      const declared = octal(header.subarray(148, 156)),
        sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0)
      if (declared !== sum) cefError('BAD_ARCHIVE', 'Tar checksum mismatch')
      const prefix = field(header.subarray(345, 500)),
        name = field(header.subarray(0, 100)),
        path = (prefix ? prefix + '/' : '') + name
      const entry = expected.get(path)
      if (!entry || seen.has(path))
        cefError('BAD_ARCHIVE', 'Unknown or duplicate runtime archive member')
      seen.add(path)
      const size = octal(header.subarray(124, 136)),
        mode = octal(header.subarray(100, 108)),
        type = header[156],
        target = field(header.subarray(157, 257))
      if (entry.type === 'file') {
        if (![0, 48].includes(type!) || target || size !== entry.size || mode !== entry.mode)
          cefError('BAD_ARCHIVE', 'Runtime file metadata mismatch')
        const f = await open(join(destination, path), 'wx', entry.mode),
          hash = createHash('sha256')
        let left = size
        try {
          while (left) {
            const chunk = (await blocks.read(Math.min(left, 65536)))!
            left -= chunk.length
            hash.update(chunk)
            await writeAll(f, chunk, signal)
          }
          if (hash.digest('hex') !== entry.sha256)
            cefError('INTEGRITY_ERROR', 'Runtime member hash mismatch')
          await f.sync()
        } finally {
          await f.close()
        }
        await chmod(join(destination, path), entry.mode)
        const padding = (512 - (size % 512)) % 512
        if (padding && !(await blocks.read(padding))!.every((v) => v === 0))
          cefError('BAD_ARCHIVE', 'Nonzero tar member padding')
      } else if (entry.type === 'directory') {
        if (type !== 53 || size !== 0 || target || mode !== entry.mode)
          cefError('BAD_ARCHIVE', 'Runtime directory metadata mismatch')
      } else if (
        type !== 50 ||
        size !== 0 ||
        target !== entry.target ||
        (mode !== 0o777 && mode !== 0o755)
      )
        cefError('BAD_ARCHIVE', 'Runtime symlink metadata mismatch')
    }
    for (;;) {
      const tail = await blocks.read(512, true)
      if (tail === null) break
      if (tail.some((v) => v !== 0)) cefError('BAD_ARCHIVE', 'Trailing archive data')
    }
    if (blocks.received !== manifest.archive.tarBytes || seen.size !== expected.size)
      cefError('BAD_ARCHIVE', 'Incomplete runtime archive inventory')
    // Links are materialized last. No archive write can traverse one.
    for (const f of manifest.members)
      if (f.type === 'symlink') await symlink(f.target, join(destination, f.path))
    await validateCefDirectory(destination, manifest, signal)
  } finally {
    signal.removeEventListener('abort', abort)
    source.destroy()
    gzip.destroy()
  }
}
async function cleanTransactions(root: string, key: string) {
  for await (const entry of await opendir(root)) {
    if (entry.name.startsWith('.cef-' + key + '.txn-')) {
      const path = join(root, entry.name)
      if (!(await lstat(path)).isDirectory() || entry.isSymbolicLink())
        cefError('UNSAFE_CACHE', 'Unexpected CEF transaction entry')
      await rm(path, { recursive: true })
    }
  }
}
export async function resolveCefRuntime(
  options: CefResolveOptions
): Promise<{ directory: string; cacheHit: boolean; manifest: CefRuntimeManifest }> {
  const manifest = verifyCefManifest(options.envelope, options.trustRoots, options.expected),
    signal = operation(options)
  signal.throwIfAborted()
  const reserve = options.reserveBytes ?? 32 * 1024 * 1024
  if (!Number.isSafeInteger(reserve) || reserve < 0)
    cefError('INVALID_ARGUMENT', 'Invalid disk reserve')
  const root = await rootDirectory(options.cacheRoot),
    key = manifest.archive.sha256,
    destination = join(root, key),
    unlock = await kernelLock(join(root, key + '.lock'), signal)
  let stage: string | undefined
  try {
    await cleanTransactions(root, key)
    if (await exists(destination)) {
      await validateCefDirectory(destination, manifest, signal)
      return { directory: destination, cacheHit: true, manifest }
    }
    if (options.offline)
      cefError('MISSING_ARTIFACT', 'Offline runtime is missing; no compiler or download fallback')
    const stats = await statfs(root, { bigint: true })
    if (stats.bsize <= 0n || stats.bavail < 0n)
      cefError('DISK_INFO_UNAVAILABLE', 'Cannot determine runtime staging capacity')
    const required =
      BigInt(manifest.archive.size) +
      manifest.members.reduce(
        (sum, f) =>
          sum +
          (f.type === 'file'
            ? ((BigInt(f.size) + stats.bsize - 1n) / stats.bsize) * stats.bsize
            : stats.bsize),
        0n
      ) +
      BigInt(reserve)
    if (stats.bsize <= 0n || stats.bavail * stats.bsize < required)
      cefError('INSUFFICIENT_DISK_SPACE', `Full CEF acquisition requires ${required} free bytes`)
    stage = join(root, '.cef-' + key + '.txn-' + randomBytes(12).toString('hex'))
    await mkdir(stage, { mode: 0o700 })
    await download(join(stage, 'runtime.tar.gz'), manifest, options, signal)
    await extract(join(stage, 'runtime.tar.gz'), join(stage, 'runtime'), manifest, signal)
    signal.throwIfAborted()
    await rename(join(stage, 'runtime'), destination)
    return { directory: destination, cacheHit: false, manifest }
  } catch (e) {
    if (['ENOSPC', 'EDQUOT'].includes(code(e) ?? ''))
      cefError(
        'INSUFFICIENT_DISK_SPACE',
        'CEF staging ran out of disk; no unverified entry accepted'
      )
    throw e
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true })
    } finally {
      await unlock()
    }
  }
}
/** Keep a shared OS lease while a cached runtime is in use, so cleanup cannot remove it. */
export async function withCefRuntime<T>(
  options: CefResolveOptions,
  run: (directory: string, manifest: CefRuntimeManifest) => Promise<T>
): Promise<T> {
  const result = await resolveCefRuntime(options),
    signal = operation(options),
    root = await rootDirectory(options.cacheRoot)
  const unlock = await kernelLock(
    join(root, result.manifest.archive.sha256 + '.lock'),
    signal,
    true
  )
  try {
    await validateCefDirectory(result.directory, result.manifest, signal)
    return await run(result.directory, result.manifest)
  } finally {
    await unlock()
  }
}
export async function removeCefRuntime(options: CefResolveOptions): Promise<void> {
  const manifest = verifyCefManifest(options.envelope, options.trustRoots, options.expected),
    signal = operation(options),
    root = await rootDirectory(options.cacheRoot)
  const unlock = await kernelLock(join(root, manifest.archive.sha256 + '.lock'), signal)
  try {
    const path = join(root, manifest.archive.sha256)
    if (await exists(path)) {
      const st = await lstat(path)
      if (!st.isDirectory() || st.isSymbolicLink())
        cefError('UNSAFE_CACHE', 'Refusing linked runtime cleanup')
      await rm(path, { recursive: true })
    }
    await cleanTransactions(root, manifest.archive.sha256)
  } finally {
    await unlock()
  }
}
