import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { readdir, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileDigest, type FileDigest } from './artifact.ts'
import { packagePath } from './paths.ts'

/** Experimental application update manifest; see docs/updates.md. */
export type UpdateFile = FileDigest & { executable: boolean }

export type UpdateManifest = {
  schemaVersion: 1
  product: string
  version: string
  /** Monotonic release order; installation never moves to an equal or lower sequence. */
  sequence: number
  /** Declared trust mode. Unsigned manifests are experimental and never verified by a key. */
  trust: 'ed25519' | 'unsigned-experimental'
  target: { os: string; architecture: string }
  compatibility: { protocol: number; bunRevision: string }
  files: Record<string, UpdateFile>
}

/** Trust is supplied by the installed updater at runtime, never by the downloaded payload. */
export type TrustPolicy =
  | { kind: 'ed25519'; publicKeys: readonly (string | KeyObject)[] }
  | { kind: 'unsigned-experimental' }

export type HostRequirements = {
  os: string
  architecture: string
  protocol: number
  bunRevision: string
}

export type VerifiedTrust = { kind: 'ed25519'; key: string } | { kind: 'unsigned-experimental' }

export type VerifiedUpdate = {
  manifest: UpdateManifest
  manifestSha256: string
  trust: VerifiedTrust
}

export type UpdateErrorCode =
  | 'malformed'
  | 'untrusted'
  | 'incompatible'
  | 'integrity'
  | 'downgrade'
  | 'busy'
  | 'state'

export class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`)
    this.name = 'UpdateError'
  }
}

export const maximumManifestBytes = 1 << 20
export const maximumFiles = 4096
export const maximumFileBytes = 2 ** 31
const productPattern = /^[a-z0-9][a-z0-9.-]{0,127}$/
const versionPattern = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/
const revisionPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/

function fail(message: string): never {
  throw new UpdateError('malformed', message)
}

function record(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} must be an object`)
  const object = value as Record<string, unknown>
  for (const key of Object.keys(object))
    if (!keys.includes(key)) fail(`${name} has unknown field ${key}`)
  for (const key of keys) if (!(key in object)) fail(`${name} is missing ${key}`)
  return object
}

function text(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${name} is invalid`)
  return value
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    fail(`${name} is invalid`)
  return value as number
}

/** Strictly parse untrusted manifest data; unknown fields and unsafe paths are rejected. */
export function parseUpdateManifest(value: unknown): UpdateManifest {
  const object = record(value, 'manifest', [
    'schemaVersion',
    'product',
    'version',
    'sequence',
    'trust',
    'target',
    'compatibility',
    'files',
  ])
  if (object['schemaVersion'] !== 1) fail('Unsupported update manifest schema')
  const trust = object['trust']
  if (trust !== 'ed25519' && trust !== 'unsigned-experimental') fail('trust is invalid')
  const target = record(object['target'], 'target', ['os', 'architecture'])
  const compatibility = record(object['compatibility'], 'compatibility', [
    'protocol',
    'bunRevision',
  ])
  const files = record(object['files'], 'files', Object.keys(object['files'] ?? {}))
  const entries = Object.entries(files)
  if (entries.length === 0 || entries.length > maximumFiles) fail('files count is invalid')
  const folded = new Set<string>()
  const parsedFiles: Record<string, UpdateFile> = {}
  for (const [path, entry] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!packagePath(path)) fail(`Unsafe file path: ${JSON.stringify(path)}`)
    // Reject paths that collide on case-insensitive or file/directory-overlapping file systems.
    const key = path.toLowerCase()
    if (folded.has(key)) fail(`Case-colliding file path: ${path}`)
    for (const other of folded)
      if (other.startsWith(`${key}/`) || key.startsWith(`${other}/`))
        fail(`File path overlaps a directory: ${path}`)
    folded.add(key)
    const file = record(entry, `files.${path}`, ['bytes', 'sha256', 'executable'])
    if (typeof file['executable'] !== 'boolean') fail(`files.${path}.executable is invalid`)
    parsedFiles[path] = {
      bytes: integer(file['bytes'], `files.${path}.bytes`, 0, maximumFileBytes),
      sha256: text(file['sha256'], `files.${path}.sha256`, sha256Pattern),
      executable: file['executable'],
    }
  }
  if (!parsedFiles['manifest.json']?.bytes) fail('The payload must include its build manifest.json')
  return {
    schemaVersion: 1,
    product: text(object['product'], 'product', productPattern),
    version: text(object['version'], 'version', versionPattern),
    sequence: integer(object['sequence'], 'sequence', 1, Number.MAX_SAFE_INTEGER),
    trust,
    target: {
      os: text(target['os'], 'target.os', /^[a-z0-9]{1,16}$/),
      architecture: text(target['architecture'], 'target.architecture', /^[a-z0-9]{1,16}$/),
    },
    compatibility: {
      protocol: integer(compatibility['protocol'], 'compatibility.protocol', 1, 65_535),
      bunRevision: text(compatibility['bunRevision'], 'compatibility.bunRevision', revisionPattern),
    },
    files: parsedFiles,
  }
}

export function keyId(key: string | KeyObject): string {
  const object = typeof key === 'string' ? createPublicKey(key) : key
  if (object.asymmetricKeyType !== 'ed25519')
    throw new UpdateError('untrusted', 'Trust keys must be Ed25519 public keys')
  const der = object.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex').slice(0, 16)
}

function decodeSignature(signature: Uint8Array): Buffer {
  const encoded = Buffer.from(signature).toString('utf8').trim()
  const bytes = Buffer.from(encoded, 'base64')
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded) || bytes.length !== 64)
    throw new UpdateError('untrusted', 'Signature must be one base64 Ed25519 signature')
  return bytes
}

/**
 * Authenticate exact manifest bytes before parsing them as an update.
 * The signature covers the raw bytes, so no JSON canonicalization is involved.
 */
export function verifyUpdate(
  bytes: Uint8Array,
  signature: Uint8Array | undefined,
  policy: TrustPolicy,
  requirements: HostRequirements
): VerifiedUpdate {
  if (bytes.length === 0 || bytes.length > maximumManifestBytes)
    fail('Manifest size is outside the supported bound')
  let trust: VerifiedTrust
  if (policy.kind === 'ed25519') {
    if (policy.publicKeys.length === 0)
      throw new UpdateError('untrusted', 'No Ed25519 trust keys are configured')
    if (!signature) throw new UpdateError('untrusted', 'Unsigned update rejected by trust policy')
    const decoded = decodeSignature(signature)
    const key = policy.publicKeys.find((candidate) => {
      const object = typeof candidate === 'string' ? createPublicKey(candidate) : candidate
      keyId(object)
      return verify(null, bytes, object, decoded)
    })
    if (!key) throw new UpdateError('untrusted', 'Signature does not match a configured trust key')
    trust = { kind: 'ed25519', key: keyId(key) }
  } else {
    if (signature)
      throw new UpdateError(
        'untrusted',
        'A signed update needs a configured trust key; it cannot be installed as unsigned'
      )
    trust = { kind: 'unsigned-experimental' }
  }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail('Manifest is not UTF-8 JSON')
  }
  const manifest = parseUpdateManifest(json)
  if (manifest.trust !== trust.kind)
    throw new UpdateError('untrusted', `Manifest declares ${manifest.trust} trust`)
  const mismatch: string[] = []
  if (manifest.target.os !== requirements.os) mismatch.push(`os ${manifest.target.os}`)
  if (manifest.target.architecture !== requirements.architecture)
    mismatch.push(`architecture ${manifest.target.architecture}`)
  if (manifest.compatibility.protocol !== requirements.protocol)
    mismatch.push(`protocol ${manifest.compatibility.protocol}`)
  if (manifest.compatibility.bunRevision !== requirements.bunRevision)
    mismatch.push(`Bun revision ${manifest.compatibility.bunRevision}`)
  if (mismatch.length)
    throw new UpdateError('incompatible', `Update requires ${mismatch.join(', ')}`)
  return {
    manifest,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    trust,
  }
}

/** The staged build manifest must agree with the authenticated update manifest. */
export async function verifyBuildManifest(directory: string, update: UpdateManifest) {
  let build: unknown
  try {
    build = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  } catch {
    throw new UpdateError('integrity', 'Build manifest is not JSON')
  }
  const object = build as {
    target?: { os?: unknown; architecture?: unknown }
    toolchain?: { bun?: { revision?: unknown } }
    application?: { file?: unknown; sha256?: unknown }
    host?: { file?: unknown; sha256?: unknown }
  }
  const problems: string[] = []
  if (object?.target?.os !== update.target.os) problems.push('target os')
  if (object?.target?.architecture !== update.target.architecture) problems.push('architecture')
  if (object?.toolchain?.bun?.revision !== update.compatibility.bunRevision)
    problems.push('Bun revision')
  for (const name of ['application', 'host'] as const) {
    const part = object?.[name]
    const file = typeof part?.file === 'string' ? update.files[part.file] : undefined
    if (!file || file.sha256 !== part?.sha256 || !file.executable)
      problems.push(`${name} executable`)
  }
  if (problems.length)
    throw new UpdateError('integrity', `Build manifest disagrees on ${problems.join(', ')}`)
}

async function inventory(root: string, prefix = ''): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) paths.push(...(await inventory(root, path)))
    else if (entry.isFile()) paths.push(path)
    else throw new Error(`Release payloads contain only regular files: ${path}`)
  }
  return paths
}

/** Describe an existing `native build` output directory as an update payload. */
export async function createUpdateManifest(
  directory: string,
  options: Pick<UpdateManifest, 'product' | 'version' | 'sequence' | 'trust'> & {
    protocol: number
  }
): Promise<UpdateManifest> {
  const build = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    target: { os: string; architecture: string }
    toolchain: { bun: { revision: string } }
    application: { file: string }
    host: { file: string }
  }
  const executables = new Set([build.application.file, build.host.file])
  const files: Record<string, UpdateFile> = {}
  for (const path of (await inventory(directory)).sort()) {
    const stats = await lstat(join(directory, path))
    files[path] = {
      ...(await fileDigest(join(directory, path))),
      executable: executables.has(path) || (process.platform !== 'win32' && !!(stats.mode & 0o100)),
    }
  }
  const manifest = parseUpdateManifest({
    schemaVersion: 1,
    product: options.product,
    version: options.version,
    sequence: options.sequence,
    trust: options.trust,
    target: build.target,
    compatibility: { protocol: options.protocol, bunRevision: build.toolchain.bun.revision },
    files,
  })
  await verifyBuildManifest(directory, manifest)
  return manifest
}

/** Produce a detached base64 Ed25519 signature over exact manifest bytes. */
export function signUpdate(bytes: Uint8Array, privateKey: string | KeyObject): string {
  return sign(null, bytes, privateKey).toString('base64') + '\n'
}
