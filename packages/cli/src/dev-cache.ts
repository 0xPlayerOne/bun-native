import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export type DevelopmentErrorCode =
  | 'INVALID_CONFIG'
  | 'CACHE_BUSY'
  | 'CACHE_INTEGRITY'
  | 'INPUT_INTEGRITY'
  | 'INSTANCE_BUSY'
  | 'CAPACITY'
  | 'FRONTEND_UNAVAILABLE'
  | 'PORT_IN_USE'
  | 'BUILD_FAILED'
  | 'RELOAD_FAILED'
  | 'RESTART_REQUIRED'
  | 'CLOSED'

export class DevelopmentError extends Error {
  constructor(
    readonly code: DevelopmentErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'DevelopmentError'
  }
}

/** Supplied by the trusted runtime selector, never inferred from an untrusted checksum URL. */
export interface DevelopmentHostInput {
  readonly name: string
  readonly path: string
  readonly sha256: string
}
export interface DevelopmentHostIdentity {
  readonly appId: string
  readonly nativeAbi: string
  readonly engineVersion: string
  readonly target: string
  readonly bunVersion: string
  /** Host/bootstrap, permissions, origins and native configuration; ordinary service code is excluded. */
  readonly configuration: string
  /** The verified native host, engine inventory/manifest, Bun and stable bootstrap identities. */
  readonly inputs: readonly DevelopmentHostInput[]
}
export interface PreparedDevelopmentHost {
  readonly key: string
  readonly directory: string
  readonly entrypoint: string
  readonly cacheHit: boolean
  readonly verifiedBytes: number
  readonly durationMs: number
}
export interface PrepareDevelopmentHostOptions {
  readonly cacheRoot: string
  readonly identity: DevelopmentHostIdentity
  /** Cold-only assembly from already acquired artifacts. This API never invokes a compiler. */
  readonly assemble: (directory: string, signal?: AbortSignal) => Promise<{ entrypoint: string }>
  readonly signal?: AbortSignal
  readonly lockTimeoutMs?: number
}
interface FileEntry {
  readonly path: string
  readonly kind: 'file' | 'directory' | 'link'
  readonly mode: number
  readonly bytes: number
  readonly sha256: string
  readonly target?: string
}
interface CacheReceipt {
  readonly schema: 1
  readonly key: string
  readonly entrypoint: string
  readonly files: readonly FileEntry[]
}
const receiptName = 'bunly-dev-host.json'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const inDirectory = (directory: string, path: string): boolean => {
  const rel = relative(directory, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
const regularLabel = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:@+/-]{1,128}$/.test(value)
function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new DevelopmentError('INVALID_CONFIG', 'Host configuration is too deep')
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value).sort())
      output[key] = canonical((value as Record<string, unknown>)[key], depth + 1)
    return output
  }
  return value
}
async function fileHash(
  path: string,
  signal?: AbortSignal
): Promise<{ sha256: string; bytes: number }> {
  const hasher = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) {
    hasher.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hasher.digest('hex'), bytes }
}
/** Fingerprints actual selected bytes and configuration, rather than timestamps or source labels. */
export async function developmentHostKey(
  identity: DevelopmentHostIdentity,
  signal?: AbortSignal
): Promise<{ key: string; verifiedBytes: number }> {
  if (
    ![
      identity.appId,
      identity.nativeAbi,
      identity.engineVersion,
      identity.target,
      identity.bunVersion,
    ].every(regularLabel) ||
    typeof identity.configuration !== 'string' ||
    Buffer.byteLength(identity.configuration) > 65536 ||
    !Array.isArray(identity.inputs) ||
    identity.inputs.length < 1 ||
    identity.inputs.length > 4096
  )
    throw new DevelopmentError('INVALID_CONFIG', 'Invalid development host identity')
  let configuration: unknown
  try {
    configuration = canonical(JSON.parse(identity.configuration))
  } catch {
    throw new DevelopmentError('INVALID_CONFIG', 'Host configuration must be bounded JSON')
  }
  const names = new Set<string>()
  const inputs: { name: string; pathIdentity: string; sha256: string; bytes: number }[] = []
  let verifiedBytes = 0
  for (const input of identity.inputs) {
    abort(signal)
    if (!regularLabel(input.name) || names.has(input.name) || !/^[a-f0-9]{64}$/.test(input.sha256))
      throw new DevelopmentError('INVALID_CONFIG', 'Invalid or duplicate native input identity')
    names.add(input.name)
    const path = await realpath(input.path)
    if (!(await lstat(path)).isFile())
      throw new DevelopmentError(
        'INPUT_INTEGRITY',
        'A selected runtime input is not a regular file'
      )
    const actual = await fileHash(path, signal)
    if (actual.sha256 !== input.sha256)
      throw new DevelopmentError(
        'INPUT_INTEGRITY',
        'Selected runtime input does not match its trusted inventory'
      )
    verifiedBytes += actual.bytes
    // A cached host may reference the selected artifact in place. Moving it invalidates that reference.
    inputs.push({ name: input.name, pathIdentity: hash(path), ...actual })
  }
  inputs.sort((a, b) => a.name.localeCompare(b.name))
  return {
    key: hash(
      JSON.stringify({
        schema: 1,
        appId: identity.appId,
        nativeAbi: identity.nativeAbi,
        engineVersion: identity.engineVersion,
        target: identity.target,
        bunVersion: identity.bunVersion,
        configuration,
        inputs,
      })
    ),
    verifiedBytes,
  }
}
async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new DevelopmentError('CACHE_INTEGRITY', 'Development cache must be a real directory')
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
  )
    throw new DevelopmentError('CACHE_INTEGRITY', 'Development cache must be private to its owner')
  return realpath(path)
}
async function inventory(directory: string, signal?: AbortSignal): Promise<FileEntry[]> {
  const files: FileEntry[] = []
  async function walk(prefix: string): Promise<void> {
    for (const name of (await readdir(join(directory, prefix))).sort()) {
      abort(signal)
      if (!prefix && name === receiptName) continue
      const path = prefix ? `${prefix}/${name}` : name
      const full = join(directory, path)
      const stat = await lstat(full)
      if (files.length >= 16384)
        throw new DevelopmentError('CACHE_INTEGRITY', 'Prepared host inventory exceeds its bound')
      const mode = process.platform === 'win32' ? 0 : stat.mode & 0o777
      if (stat.isDirectory()) {
        files.push({ path, kind: 'directory', mode, bytes: 0, sha256: hash('') })
        await walk(path)
      } else if (stat.isFile()) {
        files.push({ path, kind: 'file', mode, ...(await fileHash(full, signal)) })
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(full)
        if (
          isAbsolute(target) ||
          !inDirectory(directory, resolve(dirname(full), target)) ||
          !inDirectory(directory, await realpath(full))
        )
          throw new DevelopmentError('CACHE_INTEGRITY', 'Prepared host link escapes its inventory')
        files.push({
          path,
          kind: 'link',
          mode,
          bytes: Buffer.byteLength(target),
          sha256: hash(target),
          target,
        })
      } else {
        throw new DevelopmentError(
          'CACHE_INTEGRITY',
          'Prepared host contains a nonregular resource'
        )
      }
    }
  }
  await walk('')
  return files
}
function safeEntry(entrypoint: string, directory: string): string {
  if (
    typeof entrypoint !== 'string' ||
    !entrypoint ||
    isAbsolute(entrypoint) ||
    entrypoint.includes('\\') ||
    !inDirectory(directory, resolve(directory, entrypoint)) ||
    entrypoint === receiptName
  )
    throw new DevelopmentError(
      'CACHE_INTEGRITY',
      'Prepared host entry must remain inside its cache'
    )
  return resolve(directory, entrypoint)
}
async function readPrepared(
  directory: string,
  key: string,
  signal?: AbortSignal
): Promise<CacheReceipt | undefined> {
  let source: string
  try {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new DevelopmentError('CACHE_INTEGRITY', 'Invalid prepared host directory')
    const receipt = join(directory, receiptName)
    const receiptStat = await lstat(receipt)
    if (!receiptStat.isFile() || receiptStat.size > 4 * 1024 * 1024)
      throw new DevelopmentError('CACHE_INTEGRITY', 'Invalid prepared host receipt')
    source = await readFile(receipt, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // An absent published directory is a miss; an incomplete published directory is corruption.
      try {
        await lstat(directory)
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      }
    }
    throw new DevelopmentError('CACHE_INTEGRITY', 'Prepared host is incomplete or unreadable')
  }
  let receipt: CacheReceipt
  try {
    receipt = JSON.parse(source) as CacheReceipt
    if (receipt.schema !== 1 || receipt.key !== key || !Array.isArray(receipt.files))
      throw new Error()
    const entry = safeEntry(receipt.entrypoint, directory)
    const files = await inventory(directory, signal)
    if (JSON.stringify(files) !== JSON.stringify(receipt.files) || !(await lstat(entry)).isFile())
      throw new Error()
  } catch {
    throw new DevelopmentError(
      'CACHE_INTEGRITY',
      'Prepared host no longer matches its complete inventory'
    )
  }
  return receipt
}

/** Shared immutable prepared hosts, separate from mutable per-instance browser profiles and code. */
export async function prepareDevelopmentHost(
  options: PrepareDevelopmentHostOptions
): Promise<PreparedDevelopmentHost> {
  const started = performance.now()
  const { key, verifiedBytes } = await developmentHostKey(options.identity, options.signal)
  const root = await privateDirectory(resolve(options.cacheRoot))
  const directory = join(root, key)
  const lock = directory + '.lock'
  const timeout = options.lockTimeoutMs ?? 10000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
    throw new DevelopmentError('INVALID_CONFIG', 'Invalid prepared-host lock deadline')
  const deadline = performance.now() + timeout
  for (;;) {
    abort(options.signal)
    const cached = await readPrepared(directory, key, options.signal)
    if (cached)
      return {
        key,
        directory,
        entrypoint: safeEntry(cached.entrypoint, directory),
        cacheHit: true,
        verifiedBytes,
        durationMs: performance.now() - started,
      }
    try {
      await mkdir(lock, { mode: 0o700 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (performance.now() >= deadline)
        throw new DevelopmentError(
          'CACHE_BUSY',
          'Another host preparation owns the cache lock; stale locks are never removed automatically'
        )
      await delay(20, undefined, options.signal ? { signal: options.signal } : {})
    }
  }
  const stage = join(root, `.stage-${randomUUID()}`)
  try {
    const cached = await readPrepared(directory, key, options.signal)
    if (cached)
      return {
        key,
        directory,
        entrypoint: safeEntry(cached.entrypoint, directory),
        cacheHit: true,
        verifiedBytes,
        durationMs: performance.now() - started,
      }
    await mkdir(stage, { mode: 0o700 })
    const assembled = await options.assemble(stage, options.signal)
    abort(options.signal)
    const entry = safeEntry(assembled.entrypoint, stage)
    if (!(await lstat(entry)).isFile())
      throw new DevelopmentError('CACHE_INTEGRITY', 'Host assembly did not produce its entrypoint')
    const files = await inventory(stage, options.signal)
    const receipt: CacheReceipt = {
      schema: 1,
      key,
      entrypoint: relative(stage, entry).split(sep).join('/'),
      files,
    }
    await writeFile(join(stage, receiptName), JSON.stringify(receipt) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
    // A changed artifact during assembly must not be published under the old identity.
    if ((await developmentHostKey(options.identity, options.signal)).key !== key)
      throw new DevelopmentError('INPUT_INTEGRITY', 'Runtime input changed during host assembly')
    await rename(stage, directory)
    return {
      key,
      directory,
      entrypoint: safeEntry(receipt.entrypoint, directory),
      cacheHit: false,
      verifiedBytes,
      durationMs: performance.now() - started,
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
    await rm(lock, { recursive: true })
  }
}
