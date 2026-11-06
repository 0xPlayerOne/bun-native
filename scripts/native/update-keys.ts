import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import {
  admitAuthenticatedUpdate,
  fail,
  integer,
  keyId,
  maximumManifestBytes,
  productPattern,
  record,
  text,
  UpdateError,
  type HostRequirements,
  type VerifiedTrust,
  type VerifiedUpdate,
} from './update-manifest.ts'

/**
 * Experimental key rotation and revocation for signed updates; see docs/update-lifecycle.md.
 * A key set names the Ed25519 keys that may sign one product's manifests, the key ids that
 * may never sign again, and the lowest manifest sequence that may still be installed.
 */
export type TrustedKey = {
  /** keyId(): the first 16 hex digits of the SHA-256 of the key's SPKI DER encoding. */
  id: string
  /** Base64 SPKI DER encoding of the Ed25519 public key. */
  publicKey: string
}

export type KeySet = {
  schemaVersion: 1
  product: string
  /** Monotonic key-set version; a replacement must have a higher one. */
  version: number
  /** Manifests and retained releases below this sequence are refused. */
  minimumSequence: number
  keys: TrustedKey[]
  /** Permanently revoked key ids. A successor key set keeps every entry. */
  revoked: string[]
}

export const maximumKeySetBytes = 64 * 1024
export const maximumKeys = 16
export const maximumRevoked = 256
const keyIdPattern = /^[0-9a-f]{16}$/
const spkiPattern = /^[A-Za-z0-9+/]{59}=$/
const keyedSignaturePattern = /^([0-9a-f]{16}) ([A-Za-z0-9+/]{86}==)\n?$/

function publicKeyObject(encoded: string, name: string): KeyObject {
  if (!spkiPattern.test(encoded)) fail(`${name} is not a base64 Ed25519 SPKI key`)
  const der = Buffer.from(encoded, 'base64')
  let key: KeyObject
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch {
    fail(`${name} is not a base64 Ed25519 SPKI key`)
  }
  if (key.asymmetricKeyType !== 'ed25519') fail(`${name} is not an Ed25519 key`)
  return key
}

/** Describe a public key as a key-set entry. */
export function trustedKey(publicKey: string | KeyObject): TrustedKey {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey
  return {
    id: keyId(key),
    publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

function ids(value: unknown, name: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    fail(`${name} count is invalid`)
  return value
}

/** Strictly parse an untrusted key set; unknown fields and mislabeled keys are rejected. */
export function parseKeySet(value: unknown): KeySet {
  const object = record(value, 'key set', [
    'schemaVersion',
    'product',
    'version',
    'minimumSequence',
    'keys',
    'revoked',
  ])
  if (object['schemaVersion'] !== 1) fail('Unsupported key set schema')
  const keys = ids(object['keys'], 'keys', 1, maximumKeys).map((entry, index) => {
    const key = record(entry, `keys.${index}`, ['id', 'publicKey'])
    const id = text(key['id'], `keys.${index}.id`, keyIdPattern)
    const encoded = text(key['publicKey'], `keys.${index}.publicKey`, spkiPattern)
    if (keyId(publicKeyObject(encoded, `keys.${index}.publicKey`)) !== id)
      fail(`keys.${index}.id does not identify its public key`)
    return { id, publicKey: encoded }
  })
  const revoked = ids(object['revoked'], 'revoked', 0, maximumRevoked).map((id, index) =>
    text(id, `revoked.${index}`, keyIdPattern)
  )
  const trusted = new Set(keys.map((key) => key.id))
  if (trusted.size !== keys.length) fail('keys has a duplicate id')
  if (new Set(revoked).size !== revoked.length) fail('revoked has a duplicate id')
  for (const id of revoked) if (trusted.has(id)) fail(`Key ${id} is both trusted and revoked`)
  return {
    schemaVersion: 1,
    product: text(object['product'], 'product', productPattern),
    version: integer(object['version'], 'version', 1, Number.MAX_SAFE_INTEGER),
    minimumSequence: integer(
      object['minimumSequence'],
      'minimumSequence',
      0,
      Number.MAX_SAFE_INTEGER
    ),
    keys: keys.sort((a, b) => (a.id < b.id ? -1 : 1)),
    revoked: revoked.sort(),
  }
}

/** Strictly parse key-set bytes, e.g. a stored or bootstrap keys.json. */
export function decodeKeySet(bytes: Uint8Array): KeySet {
  if (bytes.length === 0 || bytes.length > maximumKeySetBytes)
    fail('Key set size is outside the supported bound')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail('Key set is not UTF-8 JSON')
  }
  return parseKeySet(value)
}

/** Produce a detached signature naming its key: `<key id> <base64 Ed25519 signature>\n`. */
export function signWithKey(bytes: Uint8Array, privateKey: string | KeyObject): string {
  const id = keyId(createPublicKey(privateKey))
  return `${id} ${sign(null, bytes, privateKey).toString('base64')}\n`
}

/**
 * Authenticate exact bytes against a key set. The key id in the envelope only selects the key;
 * relabeling a signature with another id fails verification. Checks run in a fixed order:
 * format, revocation, membership, signature.
 */
function authenticate(
  bytes: Uint8Array,
  signature: Uint8Array | undefined,
  keys: KeySet,
  subject: string
): string {
  if (!signature) throw new UpdateError('untrusted', `${subject} is unsigned`)
  const match =
    signature.length <= 128
      ? keyedSignaturePattern.exec(Buffer.from(signature).toString('utf8'))
      : null
  if (!match)
    throw new UpdateError('untrusted', `${subject} signature must be "<key id> <base64 signature>"`)
  const [, id, encoded] = match as unknown as [string, string, string]
  if (keys.revoked.includes(id))
    throw new UpdateError('untrusted', `${subject} signer ${id} is revoked`)
  const key = keys.keys.find((candidate) => candidate.id === id)
  if (!key) throw new UpdateError('untrusted', `${subject} signer ${id} is not a trusted key`)
  const decoded = Buffer.from(encoded, 'base64')
  if (!verify(null, bytes, publicKeyObject(key.publicKey, `key ${id}`), decoded))
    throw new UpdateError('untrusted', `${subject} signature does not match key ${id}`)
  return id
}

/**
 * Authenticate a manifest against a key set, then apply the usual compatibility checks and
 * the key set's product and minimum sequence. The result installs like a verifyUpdate result.
 */
export function verifyKeyedUpdate(
  bytes: Uint8Array,
  signature: Uint8Array | undefined,
  keys: KeySet,
  requirements: HostRequirements
): VerifiedUpdate {
  if (bytes.length === 0 || bytes.length > maximumManifestBytes)
    fail('Manifest size is outside the supported bound')
  const key = authenticate(bytes, signature, keys, 'Manifest')
  const update = admitAuthenticatedUpdate(bytes, { kind: 'ed25519', key }, requirements)
  if (update.manifest.product !== keys.product)
    throw new UpdateError(
      'untrusted',
      `Manifest product ${update.manifest.product} is not covered by the ${keys.product} key set`
    )
  if (update.manifest.sequence < keys.minimumSequence)
    throw new UpdateError(
      'downgrade',
      `Manifest sequence ${update.manifest.sequence} is below the minimum ${keys.minimumSequence}`
    )
  return update
}

/**
 * Check that `next` may replace `current`: same product, a higher version, a minimum sequence
 * that does not decrease, and every existing revocation kept.
 */
export function assertKeySetSuccessor(current: KeySet, next: KeySet): void {
  if (next.product !== current.product)
    throw new UpdateError(
      'untrusted',
      `Key set for ${next.product} cannot replace the ${current.product} key set`
    )
  if (next.version <= current.version)
    throw new UpdateError(
      'downgrade',
      `Key set version ${next.version} does not advance ${current.version}`
    )
  if (next.minimumSequence < current.minimumSequence)
    throw new UpdateError(
      'downgrade',
      `Key set minimum sequence ${next.minimumSequence} is below ${current.minimumSequence}`
    )
  const withdrawn = current.revoked.filter((id) => !next.revoked.includes(id))
  if (withdrawn.length)
    throw new UpdateError(
      'untrusted',
      `Key set withdraws the revocation of ${withdrawn.join(', ')}`
    )
}

/**
 * Rotation: a new key set is accepted only when a key trusted by the current set signed its
 * exact bytes and it is a valid successor. Returns the new set; the caller persists it.
 */
export function rotateKeySet(
  current: KeySet,
  bytes: Uint8Array,
  signature: Uint8Array | undefined
): KeySet {
  if (bytes.length === 0 || bytes.length > maximumKeySetBytes)
    fail('Key set size is outside the supported bound')
  authenticate(bytes, signature, current, 'Key set')
  const next = decodeKeySet(bytes)
  assertKeySetSuccessor(current, next)
  return next
}

/** A retained or current release must not come from a revoked signer or below the minimum. */
export function assertReleaseTrusted(
  keys: KeySet,
  release: { version: string; sequence: number; trust: VerifiedTrust }
): void {
  if (release.trust.kind !== 'ed25519')
    throw new UpdateError(
      'untrusted',
      `Release ${release.version} is unsigned; the key set requires signed releases`
    )
  if (keys.revoked.includes(release.trust.key))
    throw new UpdateError(
      'untrusted',
      `Release ${release.version} was signed by revoked key ${release.trust.key}`
    )
  if (release.sequence < keys.minimumSequence)
    throw new UpdateError(
      'downgrade',
      `Release ${release.version} sequence ${release.sequence} is below the minimum ${keys.minimumSequence}`
    )
}
