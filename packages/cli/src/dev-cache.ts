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
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
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
    message: string,
    readonly cacheIntegrity?: DevelopmentCacheIntegrityDiagnostic
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
export interface DevelopmentCacheInventoryEntry {
  readonly path: string
  readonly kind: 'file' | 'directory' | 'link'
  readonly mode: number
  readonly bytes: number
  readonly sha256: string
  readonly target?: string
}
type FileEntry = DevelopmentCacheInventoryEntry
type InventoryChangeField = 'kind' | 'mode' | 'bytes' | 'sha256' | 'target' | 'propertyOrder'
export interface DevelopmentCacheIntegrityDiagnostic {
  readonly schema: 1
  readonly phase: 'receipt' | 'inventory' | 'entrypoint'
  readonly status: 'mismatch' | 'incomplete'
  readonly scanComplete: boolean
  readonly expected?: readonly DevelopmentCacheInventoryEntry[]
  readonly actual?: readonly DevelopmentCacheInventoryEntry[]
  readonly difference?: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly {
      readonly path: string
      readonly fields: readonly InventoryChangeField[]
    }[]
    readonly entryOrderChanged: boolean
  }
  readonly failure?: { readonly code: string; readonly path?: string }
}
interface InventoryScan {
  entries: FileEntry[]
  path: string | undefined
}
interface CacheReceipt {
  readonly schema: 1
  readonly key: string
  readonly entrypoint: string
  readonly files: readonly FileEntry[]
}
const receiptName = 'bunly-dev-host.json'
const maximumEntries = 16384
const maximumReceiptBytes = 4 * 1024 * 1024
const maximumDiagnosticBytes = 2 * maximumReceiptBytes
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const inDirectory = (directory: string, path: string): boolean => {
  const rel = relative(directory, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
function diagnosticPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/^(?:[A-Za-z]:|\/)/.test(value) &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}
/** Receipt contents are untrusted. Only bounded, canonical relative metadata may
 * become a diagnostic; failing this filter never changes cache admission.
 */
function diagnosticEntries(input: unknown): readonly FileEntry[] | undefined {
  if (!Array.isArray(input) || input.length > maximumEntries) return undefined
  const paths = new Set<string>(),
    entries: FileEntry[] = []
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const row = value as Record<string, unknown>
    if (
      !diagnosticPath(row['path']) ||
      paths.has(row['path']) ||
      typeof row['kind'] !== 'string' ||
      !['file', 'directory', 'link'].includes(row['kind']) ||
      !Number.isSafeInteger(row['mode']) ||
      Number(row['mode']) < 0 ||
      Number(row['mode']) > 0o777 ||
      !Number.isSafeInteger(row['bytes']) ||
      Number(row['bytes']) < 0 ||
      typeof row['sha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row['sha256'])
    )
      return undefined
    const keys = ['path', 'kind', 'mode', 'bytes', 'sha256']
    if (row['kind'] === 'link') {
      const target = row['target']
      if (
        typeof target !== 'string' ||
        target.length > 4096 ||
        !target ||
        /^(?:[A-Za-z]:|[\\/])/.test(target) ||
        target.includes('\0')
      )
        return undefined
      const destination = posix.normalize(
        posix.join(posix.dirname(row['path']), target.replaceAll('\\', '/'))
      )
      if (destination !== '.' && !diagnosticPath(destination)) return undefined
      if (row['bytes'] !== Buffer.byteLength(target) || row['sha256'] !== hash(target))
        return undefined
      keys.push('target')
    } else if (row['kind'] === 'directory' && (row['bytes'] !== 0 || row['sha256'] !== hash('')))
      return undefined
    if (Object.keys(row).sort().join('\0') !== keys.sort().join('\0')) return undefined
    paths.add(row['path'])
    entries.push(Object.freeze({ ...row }) as unknown as FileEntry)
  }
  if (Buffer.byteLength(JSON.stringify(entries)) > maximumReceiptBytes) return undefined
  return Object.freeze(entries)
}
function integrityDiagnostic(options: {
  phase: DevelopmentCacheIntegrityDiagnostic['phase']
  scanComplete: boolean
  expected: unknown
  actual: readonly FileEntry[]
  mismatch?: boolean
  error?: unknown
  path?: string | undefined
}): DevelopmentCacheIntegrityDiagnostic {
  const expected = diagnosticEntries(options.expected)
  const actual = diagnosticEntries(options.actual)
  const code = (options.error as { code?: unknown } | undefined)?.code
  const failure = {
    code: !expected
      ? 'INVALID_RECEIPT'
      : !actual
        ? 'DIAGNOSTIC_LIMIT'
        : typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)
          ? code
          : 'CACHE_INTEGRITY',
    ...(diagnosticPath(options.path) ? { path: options.path } : {}),
  }
  let diagnostic: DevelopmentCacheIntegrityDiagnostic = {
    schema: 1,
    phase: !expected ? 'receipt' : options.phase,
    status: 'incomplete',
    scanComplete: options.scanComplete,
    ...(expected ? { expected } : {}),
    ...(actual ? { actual } : {}),
    failure,
  }
  if (options.mismatch && expected && actual) {
    const before = new Map(expected.map((entry) => [entry.path, entry]))
    const after = new Map(actual.map((entry) => [entry.path, entry]))
    const fields = ['kind', 'mode', 'bytes', 'sha256', 'target'] as const
    const changed: { path: string; fields: InventoryChangeField[] }[] = []
    for (const path of [...before.keys()].filter((path) => after.has(path)).sort()) {
      const old = before.get(path)!,
        current = after.get(path)!
      const differences: InventoryChangeField[] = fields.filter(
        (field) => old[field] !== current[field]
      )
      const oldKeys = Object.keys(old),
        currentKeys = Object.keys(current)
      if (
        oldKeys.length === currentKeys.length &&
        oldKeys.every((key) => currentKeys.includes(key)) &&
        JSON.stringify(oldKeys) !== JSON.stringify(currentKeys)
      )
        differences.push('propertyOrder')
      if (differences.length) changed.push({ path, fields: differences })
    }
    diagnostic = {
      schema: 1,
      phase: 'inventory',
      status: 'mismatch',
      scanComplete: true,
      expected,
      actual,
      difference: {
        added: [...after.keys()].filter((path) => !before.has(path)).sort(),
        removed: [...before.keys()].filter((path) => !after.has(path)).sort(),
        changed,
        entryOrderChanged:
          JSON.stringify(expected.map((entry) => entry.path).filter((path) => after.has(path))) !==
          JSON.stringify(actual.map((entry) => entry.path).filter((path) => before.has(path))),
      },
    }
  }
  if (Buffer.byteLength(JSON.stringify(diagnostic)) > maximumDiagnosticBytes)
    return Object.freeze({
      schema: 1,
      phase: options.phase,
      status: 'incomplete',
      scanComplete: options.scanComplete,
      failure: { code: 'DIAGNOSTIC_LIMIT' },
    })
  return Object.freeze(diagnostic)
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
async function inventory(
  directory: string,
  signal?: AbortSignal,
  scan?: InventoryScan
): Promise<FileEntry[]> {
  const files: FileEntry[] = scan?.entries ?? []
  async function walk(prefix: string): Promise<void> {
    if (scan) scan.path = prefix || undefined
    for (const name of (await readdir(join(directory, prefix))).sort()) {
      abort(signal)
      if (!prefix && name === receiptName) continue
      const path = prefix ? `${prefix}/${name}` : name
      if (scan) scan.path = path
      const full = join(directory, path)
      const stat = await lstat(full)
      if (files.length >= maximumEntries)
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
  const stat = await lstat(directory).catch((error: unknown) => {
    // Only the initial absence is a cache miss. A complete host may be
    // atomically published before this reader handles that observation.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new DevelopmentError('CACHE_INTEGRITY', 'Prepared host is incomplete or unreadable')
  })
  if (!stat) return undefined
  let source: string
  try {
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new DevelopmentError('CACHE_INTEGRITY', 'Invalid prepared host directory')
    const receipt = join(directory, receiptName)
    const receiptStat = await lstat(receipt)
    if (!receiptStat.isFile() || receiptStat.size > maximumReceiptBytes)
      throw new DevelopmentError('CACHE_INTEGRITY', 'Invalid prepared host receipt')
    source = await readFile(receipt, 'utf8')
  } catch {
    throw new DevelopmentError('CACHE_INTEGRITY', 'Prepared host is incomplete or unreadable')
  }
  let receipt: CacheReceipt | undefined
  const scan: InventoryScan = { entries: [], path: undefined }
  let phase: DevelopmentCacheIntegrityDiagnostic['phase'] = 'receipt'
  let scanComplete = false
  let mismatch = false
  try {
    receipt = JSON.parse(source) as CacheReceipt
    if (receipt.schema !== 1 || receipt.key !== key || !Array.isArray(receipt.files))
      throw new Error()
    phase = 'entrypoint'
    const entry = safeEntry(receipt.entrypoint, directory)
    phase = 'inventory'
    const files = await inventory(directory, signal, scan)
    scanComplete = true
    mismatch = JSON.stringify(files) !== JSON.stringify(receipt.files)
    if (mismatch) throw new Error()
    phase = 'entrypoint'
    if (!(await lstat(entry)).isFile()) throw new Error()
  } catch (error) {
    let diagnostic: DevelopmentCacheIntegrityDiagnostic
    try {
      diagnostic = integrityDiagnostic({
        phase,
        scanComplete,
        mismatch,
        expected: receipt?.files,
        actual: scan.entries,
        error,
        path: phase === 'inventory' && !scanComplete ? scan.path : undefined,
      })
    } catch {
      // Diagnostic accounting must never replace the original integrity rejection.
      diagnostic = {
        schema: 1,
        phase,
        status: 'incomplete',
        scanComplete,
        failure: { code: 'DIAGNOSTIC_FAILED' },
      }
    }
    throw new DevelopmentError(
      'CACHE_INTEGRITY',
      'Prepared host no longer matches its complete inventory',
      diagnostic
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
