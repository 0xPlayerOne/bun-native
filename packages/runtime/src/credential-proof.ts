/** Native canary verification only. Never queries an application cookie profile or OS secret. */
import { Database } from 'bun:sqlite'
import { createHash, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { BunlyError } from '../../contracts/src/core.ts'

const PARTITION = 'bunly-internal-credential-proof'
const HOST = 'bunly-credential-proof.invalid'
const ORIGIN = `https://${HOST}/`
const COOKIE = '__Host-bunly-credential-proof'
const HASH = /^[a-f0-9]{64}$/
const APPLICATION =
  /^[a-z][a-z0-9]*(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z][a-z0-9]*(?:[a-z0-9-]*[a-z0-9])?)+$/
interface Proof {
  schema: 1
  status: 'flushed'
  provider: 'macos-keychain' | 'windows-dpapi' | 'linux-secret-service'
  applicationId: string
  profilePath: string
  nonce: string
  origin: string
  cookieName: string
  tag: 'v10' | 'v11'
}
export interface CookieProofReceipt {
  readonly tag: 'v10' | 'v11'
  readonly plaintextBytes: 0
  readonly encryptedBytes: number
  readonly ciphertextSha256: string
}
function denied(): never {
  throw new BunlyError(
    'UNSUPPORTED_CAPABILITY',
    'OS-protected cookie persistence could not be verified; no protected application session was opened'
  )
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) denied()
  return value as Record<string, unknown>
}
function proofValue(value: unknown, root: string, platform: string): Proof {
  const p = record(value)
  const provider = {
    darwin: 'macos-keychain',
    win32: 'windows-dpapi',
    linux: 'linux-secret-service',
  }[platform]
  if (
    Object.keys(p).sort().join(',') !==
      'applicationId,cookieName,nonce,origin,profilePath,provider,schema,status,tag' ||
    !provider ||
    p['provider'] !== provider ||
    p['schema'] !== 1 ||
    p['status'] !== 'flushed' ||
    typeof p['applicationId'] !== 'string' ||
    p['applicationId'].length > 128 ||
    !APPLICATION.test(p['applicationId']) ||
    typeof p['nonce'] !== 'string' ||
    !HASH.test(p['nonce']) ||
    p['origin'] !== ORIGIN ||
    p['cookieName'] !== COOKIE ||
    p['tag'] !== (platform === 'linux' ? 'v11' : 'v10') ||
    !isAbsolute(root) ||
    root !== resolve(root) ||
    p['profilePath'] !==
      join(root, 'bunly-profile-' + createHash('sha256').update(PARTITION).digest('hex'))
  )
    denied()
  return value as Proof
}
async function directory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path) denied()
}
async function regular(path: string, maximum: number, optional = false): Promise<boolean> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > maximum ||
    (await realpath(path)) !== path
  )
    denied()
  return true
}
async function boundedJson(path: string): Promise<unknown> {
  await regular(path, 1024 * 1024)
  const file = await open(path, 'r')
  try {
    const buffer = new Uint8Array(1024 * 1024 + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 1024 * 1024) denied()
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    )
  } finally {
    await file.close()
  }
}
// Fixed upstream fallback/mock secrets, not credentials. A version prefix alone
// cannot distinguish them from an OS-held AES-CBC key. Compare the entire known
// canary plaintext, not merely padding validity (which has false positives).
function knownFallback(ciphertext: Uint8Array, nonce: string): boolean {
  const expected = Buffer.concat([createHash('sha256').update(HOST).digest(), Buffer.from(nonce)])
  for (const [password, iterations] of [
    ['peanuts', 1],
    ['', 1],
    ['peanuts', 1003],
    ['', 1003],
    ['mock_password', 1003],
  ] as const) {
    const key = pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1')
    try {
      const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
      if (
        Buffer.concat([decipher.update(ciphertext.subarray(3)), decipher.final()]).equals(expected)
      )
        return true
    } catch {
      /* A different key cannot decrypt this canary. */
    } finally {
      key.fill(0)
    }
  }
  return false
}

/** Defense in depth for the trusted native callback; synthetic tests are not OS qualification. */
export async function verifyCookieProof(
  value: unknown,
  persistentRoot: string,
  platform: string = process.platform
): Promise<CookieProofReceipt> {
  try {
    const proof = proofValue(value, persistentRoot, platform)
    await directory(persistentRoot)
    await directory(proof.profilePath)
    const network = join(proof.profilePath, 'Network')
    const paths = [join(proof.profilePath, 'Cookies')]
    try {
      await directory(network)
      paths.push(join(network, 'Cookies'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const databases: string[] = []
    for (const path of paths) if (await regular(path, 16 * 1024 * 1024, true)) databases.push(path)
    if (databases.length !== 1) denied()
    const path = databases[0]!
    for (const suffix of ['-wal', '-shm', '-journal'])
      await regular(path + suffix, 16 * 1024 * 1024, true)
    const db = new Database(path, { readonly: true, create: false, strict: true })
    let encrypted: Uint8Array
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0;')
      const version = db
        .query<{ value: unknown }, []>("SELECT value FROM meta WHERE key='version' LIMIT 2")
        .all()
      if (version.length !== 1 || String(version[0]!.value) !== '24') denied()
      const rows = db
        .query<Record<string, unknown>, []>(
          'SELECT host_key,name,path,value,encrypted_value,is_secure,is_httponly,is_persistent FROM cookies LIMIT 2'
        )
        .all()
      if (rows.length !== 1) denied()
      const row = rows[0]!
      if (
        row['host_key'] !== HOST ||
        row['name'] !== COOKIE ||
        row['path'] !== '/' ||
        row['value'] !== '' ||
        row['is_secure'] !== 1 ||
        row['is_httponly'] !== 1 ||
        row['is_persistent'] !== 1 ||
        !(row['encrypted_value'] instanceof Uint8Array)
      )
        denied()
      encrypted = new Uint8Array(row['encrypted_value'])
    } finally {
      db.close(true)
    }
    if (
      encrypted.length < 35 ||
      encrypted.length > 8192 ||
      new TextDecoder().decode(encrypted.subarray(0, 3)) !== proof.tag
    )
      denied()
    if (platform === 'win32') {
      // CEF's pinned v10 Windows provider must use its root's DPAPI-wrapped key,
      // not an arbitrary bytestring with a recognizable ciphertext prefix.
      const state = record(await boundedJson(join(persistentRoot, 'Local State')))
      const encoded = record(state['os_crypt'])['encrypted_key']
      if (typeof encoded !== 'string' || encoded.length > 16384) denied()
      const key = Buffer.from(encoded, 'base64')
      if (
        key.toString('base64') !== encoded ||
        key.length < 37 ||
        key.subarray(0, 5).toString('ascii') !== 'DPAPI' ||
        encrypted.length < 127
      )
        denied()
    } else {
      if (
        (encrypted.length - 3) % 16 !== 0 ||
        encrypted.length < 115 ||
        knownFallback(encrypted, proof.nonce)
      )
        denied()
    }
    return Object.freeze({
      tag: proof.tag,
      plaintextBytes: 0,
      encryptedBytes: encrypted.length,
      ciphertextSha256: createHash('sha256').update(encrypted).digest('hex'),
    })
  } catch {
    denied()
  }
}

interface NativeCredentialChannel {
  call(operation: string, args: Record<string, unknown>): Promise<unknown>
}
/** One attempt per backend lifetime; failure never enables ordinary cookie persistence. */
export async function qualifyCookieProvider(
  channel: NativeCredentialChannel,
  root: string
): Promise<void> {
  let id: number | undefined
  try {
    const response = record(
      await channel.call('credentials.probe', { nonce: randomBytes(32).toString('hex') })
    )
    if (
      response['ready'] !== false ||
      !Number.isSafeInteger(response['id']) ||
      Number(response['id']) < 1 ||
      Object.keys(response).sort().join(',') !== 'id,proof,ready'
    )
      denied()
    id = Number(response['id'])
    const proof = proofValue(response['proof'], root, process.platform)
    const receipt = await verifyCookieProof(proof, root)
    await channel.call('credentials.accept', { id, nonce: proof.nonce, ...receipt })
  } catch {
    if (id !== undefined) await channel.call('credentials.discard', { id }).catch(() => {})
    denied()
  }
}
