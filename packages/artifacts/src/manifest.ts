import { createHash, createPublicKey, verify } from 'node:crypto'
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
export interface ArtifactIdentity {
  readonly kind: 'host-probe'
  readonly version: string
  readonly abi: 1
  readonly backend: 'none'
  readonly target: 'darwin-arm64' | 'linux-x64' | 'win32-x64'
  readonly bun: string
  readonly nativeToolchain: string
  readonly cef: null
}
export interface ArtifactFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly executable: boolean
}
export interface ArtifactManifest {
  readonly schema: 1
  readonly identity: ArtifactIdentity
  readonly archive: {
    readonly url: string
    readonly size: number
    readonly sha256: string
    readonly format: 'ustar'
  }
  readonly files: readonly ArtifactFile[]
}
export interface SignedManifest {
  readonly keyId: string
  readonly payload: string
  readonly signature: string
}
export class ArtifactError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ArtifactError'
    this.code = code
  }
}
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
export function safeRelativePath(path: string): string {
  if (
    typeof path !== 'string' ||
    !path ||
    Buffer.byteLength(path) > 240 ||
    /[\\:<>"|?*]/.test(path) ||
    Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    path.startsWith('/')
  )
    throw new ArtifactError('UNSAFE_PATH', 'Invalid artifact path')
  for (const part of path.split('/')) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
      throw new ArtifactError('UNSAFE_PATH', 'Artifact path is not portable or contained')
  }
  return path
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ArtifactError('BAD_MANIFEST', 'Expected object')
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|'))
    throw new ArtifactError('BAD_MANIFEST', 'Unknown or missing fields')
}
function version(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(value)
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
function parseIdentity(value: unknown): ArtifactIdentity {
  const i = record(value)
  exactKeys(i, ['kind', 'version', 'abi', 'backend', 'target', 'bun', 'nativeToolchain', 'cef'])
  if (
    i['kind'] !== 'host-probe' ||
    i['abi'] !== 1 ||
    i['backend'] !== 'none' ||
    i['cef'] !== null ||
    !version(i['version']) ||
    !version(i['bun']) ||
    typeof i['nativeToolchain'] !== 'string' ||
    !/^rust-\d+\.\d+\.\d+$/.test(i['nativeToolchain']) ||
    !['darwin-arm64', 'linux-x64', 'win32-x64'].includes(i['target'] as string)
  )
    throw new ArtifactError('BAD_MANIFEST', 'Unsupported artifact identity')
  return Object.freeze({ ...i }) as unknown as ArtifactIdentity
}
export function parseManifest(value: unknown): ArtifactManifest {
  const m = record(value)
  exactKeys(m, ['schema', 'identity', 'archive', 'files'])
  if (m['schema'] !== 1) throw new ArtifactError('BAD_MANIFEST', 'Unsupported artifact schema')
  const identity = parseIdentity(m['identity'])
  const a = record(m['archive'])
  exactKeys(a, ['url', 'size', 'sha256', 'format'])
  if (
    a['format'] !== 'ustar' ||
    typeof a['url'] !== 'string' ||
    !Number.isSafeInteger(a['size']) ||
    (a['size'] as number) < 1024 ||
    (a['size'] as number) > MAX_ARCHIVE_BYTES ||
    !hash(a['sha256'])
  )
    throw new ArtifactError('BAD_MANIFEST', 'Invalid archive')
  let url: URL
  try {
    url = new URL(a['url'])
  } catch {
    throw new ArtifactError('BAD_MANIFEST', 'Invalid artifact URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new ArtifactError('BAD_MANIFEST', 'Artifact URL must be credential-free HTTPS')
  if (!Array.isArray(m['files']) || m['files'].length === 0 || m['files'].length > 1024)
    throw new ArtifactError('BAD_MANIFEST', 'Invalid file inventory')
  const files = m['files'].map((raw: unknown) => {
    const f = record(raw)
    exactKeys(f, ['path', 'size', 'sha256', 'executable'])
    if (
      typeof f['path'] !== 'string' ||
      !Number.isSafeInteger(f['size']) ||
      (f['size'] as number) < 0 ||
      !hash(f['sha256']) ||
      typeof f['executable'] !== 'boolean'
    )
      throw new ArtifactError('BAD_MANIFEST', 'Invalid file entry')
    safeRelativePath(f['path'])
    return Object.freeze({ ...f }) as unknown as ArtifactFile
  })
  const names = files.map((f) => f.path.toLowerCase().normalize('NFC'))
  if (
    new Set(names).size !== names.length ||
    names.some((n) => names.some((other) => other.startsWith(n + '/')))
  )
    throw new ArtifactError(
      'BAD_MANIFEST',
      'Duplicate, case-colliding or overlapping artifact paths'
    )
  if (files.reduce((sum, f) => sum + f.size, 0) > MAX_ARCHIVE_BYTES)
    throw new ArtifactError('BAD_MANIFEST', 'Oversized file inventory')
  return Object.freeze({
    schema: 1,
    identity,
    archive: Object.freeze({ ...a }) as unknown as ArtifactManifest['archive'],
    files: Object.freeze(files),
  })
}
function decode64(value: unknown, max: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > max * 2 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new ArtifactError('BAD_MANIFEST', 'Invalid base64 encoding')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length > max) throw new ArtifactError('BAD_MANIFEST', 'Oversized manifest field')
  return decoded
}
/** Trust roots are passed by the installer/application, never downloaded with the manifest. */
export function verifyManifest(
  envelope: SignedManifest,
  trustRoots: Readonly<Record<string, string>>,
  expected: ArtifactIdentity
): ArtifactManifest {
  if (!envelope || typeof envelope.keyId !== 'string' || !Object.hasOwn(trustRoots, envelope.keyId))
    throw new ArtifactError('UNTRUSTED_KEY', 'Unknown manifest signing key')
  const payload = decode64(envelope.payload, 1024 * 1024)
  const signature = decode64(envelope.signature, 64)
  const key = createPublicKey(trustRoots[envelope.keyId]!)
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    signature.length !== 64 ||
    !verify(null, payload, key, signature)
  )
    throw new ArtifactError('BAD_SIGNATURE', 'Manifest signature verification failed')
  let data: unknown
  try {
    data = JSON.parse(payload.toString('utf8'))
  } catch {
    throw new ArtifactError('BAD_MANIFEST', 'Invalid manifest JSON')
  }
  const manifest = parseManifest(data)
  const expectedIdentity = parseIdentity(expected)
  for (const field of Object.keys(manifest.identity) as (keyof ArtifactIdentity)[]) {
    if (manifest.identity[field] !== expectedIdentity[field])
      throw new ArtifactError('IDENTITY_MISMATCH', `Unexpected artifact ${field}`)
  }
  return manifest
}
