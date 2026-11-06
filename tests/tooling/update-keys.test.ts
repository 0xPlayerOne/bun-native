import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acceptKeySet,
  directorySource,
  install,
  readKeySet,
  readState,
  rollback,
  trustedKeySet,
  uninstall,
} from '../../scripts/native/installation.ts'
import { launch } from '../../scripts/native/lifecycle.ts'
import {
  decodeKeySet,
  parseKeySet,
  rotateKeySet,
  signWithKey,
  trustedKey,
  verifyKeyedUpdate,
  type KeySet,
} from '../../scripts/native/update-keys.ts'
import { signUpdate, verifyUpdate } from '../../scripts/native/update-manifest.ts'
import { cleanup, installed, rejects, release, requirements, temporary } from './update-fixture.ts'

afterEach(cleanup)

type Pair = { publicKey: KeyObject; privateKey: KeyObject }
const [a, b, c] = [0, 1, 2].map(() => generateKeyPairSync('ed25519')) as [Pair, Pair, Pair]
const id = (pair: Pair) => trustedKey(pair.publicKey).id
const product = 'dev.bun-native.example'

function keySet(
  version: number,
  keys: Pair[],
  options: { revoked?: Pair[]; minimumSequence?: number; product?: string } = {}
): KeySet {
  return parseKeySet({
    schemaVersion: 1,
    product: options.product ?? product,
    version,
    minimumSequence: options.minimumSequence ?? 0,
    keys: keys.map((pair) => trustedKey(pair.publicKey)),
    revoked: (options.revoked ?? []).map(id),
  })
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const signature = (bytes: Uint8Array, pair: Pair) =>
  Buffer.from(signWithKey(bytes, pair.privateKey))

async function keyed(label: string, sequence: number, signer: Pair, product?: string) {
  const update = await release(label, sequence, 'ed25519', (manifest) => {
    if (product) manifest.product = product
  })
  return { ...update, signature: signature(update.bytes, signer) }
}

test('a manifest signed by a trusted key id installs and records that key', async () => {
  const root = join(await temporary(), 'install')
  const update = await keyed('one', 1, a)
  expect(update.signature.toString()).toMatch(new RegExp(`^${id(a)} [A-Za-z0-9+/]{86}==\\n$`))
  const verified = verifyKeyedUpdate(update.bytes, update.signature, keySet(1, [a]), requirements)
  expect(verified.trust).toEqual({ kind: 'ed25519', key: id(a) })
  const state = await install(root, verified, directorySource(update.payload))
  expect(state.current.trust).toEqual({ kind: 'ed25519', key: id(a) })
  await installed(root, 'one')
})

test('rotation introduces keys through a trusted signer; revoked keys fail even when valid', async () => {
  const root = join(await temporary(), 'install')
  const bootstrap = keySet(1, [a])
  // Version 2 introduces B, signed by the currently trusted A.
  const second = encode(keySet(2, [a, b]))
  expect(await acceptKeySet(root, bootstrap, second, signature(second, a))).toEqual(
    keySet(2, [a, b])
  )
  const one = await keyed('one', 1, b)
  await install(
    root,
    verifyKeyedUpdate(one.bytes, one.signature, await trustedKeySet(root, bootstrap), requirements),
    directorySource(one.payload)
  )
  // Version 3, signed by B, adds C, revokes A and raises the minimum sequence.
  const third = encode(keySet(3, [b, c], { revoked: [a], minimumSequence: 2 }))
  const accepted = await acceptKeySet(root, bootstrap, third, signature(third, b))
  expect(accepted.revoked).toEqual([id(a)])
  expect(await readKeySet(root)).toEqual(accepted)
  const keys = await trustedKeySet(root, bootstrap)
  expect(keys).toEqual(accepted)

  // A's signature is genuine, but A is revoked.
  const byA = await keyed('two', 2, a)
  const revoked = await rejects(
    () => verifyKeyedUpdate(byA.bytes, byA.signature, keys, requirements),
    'untrusted'
  )
  expect(revoked.message).toBe(`untrusted: Manifest signer ${id(a)} is revoked`)
  // The legacy verifier with A as a configured key would accept it; the key set does not.
  expect(() =>
    verifyUpdate(
      byA.bytes,
      Buffer.from(signUpdate(byA.bytes, a.privateKey)),
      { kind: 'ed25519', publicKeys: [a.publicKey] },
      requirements
    )
  ).not.toThrow()
  const low = await keyed('low', 1, c)
  expect(
    (
      await rejects(
        () => verifyKeyedUpdate(low.bytes, low.signature, keys, requirements),
        'downgrade'
      )
    ).message
  ).toBe('downgrade: Manifest sequence 1 is below the minimum 2')
  const byC = await keyed('two', 2, c)
  await install(
    root,
    verifyKeyedUpdate(byC.bytes, byC.signature, keys, requirements),
    directorySource(byC.payload)
  )
  await installed(root, 'two')

  // Failed rotations leave the stored key set unchanged.
  const stored = await readFile(join(root, 'keys.json'), 'utf8')
  const rotations: [Uint8Array, Pair, string, string][] = [
    // Replaying an older version, even signed by a trusted key.
    [
      encode(keySet(2, [b, c], { revoked: [a], minimumSequence: 2 })),
      b,
      'downgrade',
      'Key set version 2 does not advance 3',
    ],
    // The revoked key cannot sign its way back in.
    [encode(keySet(4, [a, b])), a, 'untrusted', `Key set signer ${id(a)} is revoked`],
    // Revocation is permanent.
    [
      encode(keySet(4, [b, c], { minimumSequence: 2 })),
      b,
      'untrusted',
      `Key set withdraws the revocation of ${id(a)}`,
    ],
    [
      encode(keySet(4, [b, c], { revoked: [a], minimumSequence: 1 })),
      b,
      'downgrade',
      'Key set minimum sequence 1 is below 2',
    ],
    [
      encode(
        keySet(4, [b, c], { revoked: [a], minimumSequence: 2, product: 'dev.bun-native.other' })
      ),
      b,
      'untrusted',
      `Key set for dev.bun-native.other cannot replace the ${product} key set`,
    ],
  ]
  for (const [bytes, signer, code, message] of rotations) {
    const error = await rejects(
      acceptKeySet(root, bootstrap, bytes, signature(bytes, signer)),
      code as 'untrusted'
    )
    expect(error.message).toBe(`${code}: ${message}`)
    expect(await readFile(join(root, 'keys.json'), 'utf8')).toBe(stored)
  }
  expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

test('unknown, relabeled, tampered, malformed and legacy signatures are rejected', async () => {
  const keys = keySet(1, [a, b])
  const update = await keyed('one', 1, a)
  const cases: [Uint8Array, Uint8Array | undefined, KeySet, string][] = [
    [
      update.bytes,
      signature(update.bytes, c),
      keys,
      `Manifest signer ${id(c)} is not a trusted key`,
    ],
    [
      update.bytes,
      Buffer.from(update.signature.toString().replace(id(a), id(b))),
      keys,
      `Manifest signature does not match key ${id(b)}`,
    ],
    [
      Buffer.from(update.bytes.toString().replace('1.0.1', '1.0.9')),
      update.signature,
      keys,
      `Manifest signature does not match key ${id(a)}`,
    ],
    [
      update.bytes,
      Buffer.from(signUpdate(update.bytes, a.privateKey)),
      keys,
      'Manifest signature must be "<key id> <base64 signature>"',
    ],
    [
      update.bytes,
      Buffer.from(`${id(a)}  ${update.signature.toString().split(' ')[1]}`),
      keys,
      'Manifest signature must be "<key id> <base64 signature>"',
    ],
    [
      update.bytes,
      Buffer.alloc(4096, 'a'),
      keys,
      'Manifest signature must be "<key id> <base64 signature>"',
    ],
    [update.bytes, undefined, keys, 'Manifest is unsigned'],
  ]
  for (const [bytes, signed, set, message] of cases) {
    const error = await rejects(
      () => verifyKeyedUpdate(bytes, signed, set, requirements),
      'untrusted'
    )
    expect(error.message).toBe(`untrusted: ${message}`)
  }
  const foreign = await keyed('foreign', 1, a, 'dev.bun-native.other')
  expect(
    (
      await rejects(
        () => verifyKeyedUpdate(foreign.bytes, foreign.signature, keys, requirements),
        'untrusted'
      )
    ).message
  ).toContain('is not covered by the')
  const unsigned = await release('unsigned', 1, 'unsigned-experimental')
  await rejects(
    () => verifyKeyedUpdate(unsigned.bytes, signature(unsigned.bytes, a), keys, requirements),
    'untrusted'
  )
  await rejects(
    () => verifyKeyedUpdate(update.bytes, update.signature, keys, { ...requirements, os: 'plan9' }),
    'incompatible'
  )
  await rejects(
    () => verifyKeyedUpdate(Buffer.alloc(0), update.signature, keys, requirements),
    'malformed'
  )
  // A tampered rotation document fails before it is parsed.
  const next = encode(keySet(2, [a, b, c]))
  const tampered = Buffer.from(next.toString().replace('"version": 2', '"version": 9'))
  await rejects(() => rotateKeySet(keys, tampered, signature(next, a)), 'untrusted')
  expect(rotateKeySet(keys, next, signature(next, a)).version).toBe(2)
})

test('key sets are parsed strictly', async () => {
  const base = keySet(1, [a], { revoked: [b] })
  const x25519 = generateKeyPairSync('x25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64')
  const cases: ((set: Record<string, unknown> & KeySet) => void)[] = [
    (set) => Object.assign(set, { channel: 'beta' }),
    (set) => Reflect.deleteProperty(set, 'revoked'),
    (set) => Object.assign(set, { schemaVersion: 2 }),
    (set) => Object.assign(set, { version: 0 }),
    (set) => Object.assign(set, { minimumSequence: -1 }),
    (set) => Object.assign(set, { product: 'Not A Product' }),
    (set) => Object.assign(set, { keys: [] }),
    (set) => Object.assign(set, { keys: {} }),
    (set) =>
      Object.assign(set, {
        keys: Array.from({ length: 17 }, () =>
          trustedKey(generateKeyPairSync('ed25519').publicKey)
        ),
      }),
    (set) => Object.assign(set, { keys: [trustedKey(a.publicKey), trustedKey(a.publicKey)] }),
    (set) => Object.assign(set, { keys: [{ ...trustedKey(a.publicKey), id: id(b) }] }),
    (set) => Object.assign(set, { keys: [{ ...trustedKey(a.publicKey), extra: true }] }),
    (set) => Object.assign(set, { keys: [{ id: '0'.repeat(16), publicKey: x25519 }] }),
    (set) => Object.assign(set, { keys: [{ id: id(a), publicKey: 'A'.repeat(59) + '=' }] }),
    (set) => Object.assign(set, { revoked: [id(a)] }),
    (set) => Object.assign(set, { revoked: [id(b), id(b)] }),
    (set) => Object.assign(set, { revoked: ['ABCDEF0123456789'] }),
  ]
  for (const edit of cases) {
    const set = structuredClone(base) as Record<string, unknown> & KeySet
    edit(set)
    await rejects(() => parseKeySet(set), 'malformed')
  }
  // Entries are normalized to a sorted order so equal sets compare equal.
  const reversed = {
    ...structuredClone(base),
    keys: [trustedKey(c.publicKey), trustedKey(a.publicKey)],
  }
  expect(parseKeySet(reversed).keys.map((key) => key.id)).toEqual([id(a), id(c)].sort())
  await rejects(() => decodeKeySet(Buffer.from('{not json')), 'malformed')
  await rejects(() => decodeKeySet(Buffer.from([0xff, 0xfe])), 'malformed')
  await rejects(() => decodeKeySet(Buffer.alloc(64 * 1024 + 1, 0x20)), 'malformed')
  expect(decodeKeySet(encode(base))).toEqual(base)
})

test('stored key sets fail closed when corrupt, conflicting or not a successor', async () => {
  const root = join(await temporary(), 'install')
  const bootstrap = keySet(1, [a])
  expect(await readKeySet(root)).toBeNull()
  expect(await trustedKeySet(root, bootstrap)).toBe(bootstrap)
  const second = encode(keySet(2, [b], { revoked: [a] }))
  await acceptKeySet(root, bootstrap, second, signature(second, a))
  // An updater shipping a newer valid successor supersedes the stored set.
  const shipped = keySet(3, [b, c], { revoked: [a] })
  expect(await trustedKeySet(root, shipped)).toBe(shipped)
  // A newer bootstrap cannot silently withdraw a stored revocation.
  await rejects(trustedKeySet(root, keySet(3, [a, b])), 'untrusted')
  // Two different key sets with the same version conflict.
  await rejects(trustedKeySet(root, keySet(2, [c])), 'state')
  // A stored set for another product is not a successor of this bootstrap.
  await rejects(
    trustedKeySet(root, keySet(1, [a], { product: 'dev.bun-native.other' })),
    'untrusted'
  )
  await writeFile(join(root, 'keys.json'), '{"schemaVersion":1}')
  await rejects(trustedKeySet(root, bootstrap), 'state')
  await rejects(readKeySet(root), 'state')
})

test('rollback and launch refuse releases from revoked signers or below the minimum', async () => {
  const root = join(await temporary(), 'install')
  const both = keySet(1, [a, b])
  for (const [label, sequence, signer] of [
    ['one', 1, a],
    ['two', 2, b],
  ] as const) {
    const update = await keyed(label, sequence, signer)
    await install(
      root,
      verifyKeyedUpdate(update.bytes, update.signature, both, requirements),
      directorySource(update.payload)
    )
  }
  const before = await readFile(join(root, 'state.json'), 'utf8')
  const revokesA = keySet(2, [b], { revoked: [a] })
  expect((await rejects(rollback(root, { keys: revokesA }), 'untrusted')).message).toBe(
    `untrusted: Release 1.0.1 was signed by revoked key ${id(a)}`
  )
  await rejects(rollback(root, { keys: keySet(2, [a, b], { minimumSequence: 2 }) }), 'downgrade')
  expect(await readFile(join(root, 'state.json'), 'utf8')).toBe(before)
  expect((await launch(root, { keys: revokesA })).release.version).toBe('1.0.2')
  await rejects(launch(root, { keys: keySet(2, [a], { revoked: [b] }) }), 'untrusted')
  // Without a key set the existing rollback behavior is unchanged.
  expect((await rollback(root)).current.version).toBe('1.0.1')
  await rejects(launch(root, { keys: revokesA }), 'untrusted')

  // An unsigned retained release is refused when a key set is enforced.
  const other = join(await temporary(), 'install')
  for (const [label, sequence] of [
    ['one', 1],
    ['two', 2],
  ] as const) {
    const update = await release(label, sequence, 'unsigned-experimental')
    await install(
      other,
      verifyUpdate(update.bytes, undefined, { kind: 'unsigned-experimental' }, requirements),
      directorySource(update.payload)
    )
  }
  await rejects(rollback(other, { keys: both }), 'untrusted')
  expect((await readState(other))?.current.version).toBe('1.0.2')
})

test('uninstall removes the stored key set with the other updater-owned files', async () => {
  const root = join(await temporary(), 'install')
  const update = await keyed('one', 1, a)
  await install(
    root,
    verifyKeyedUpdate(update.bytes, update.signature, keySet(1, [a]), requirements),
    directorySource(update.payload)
  )
  const next = encode(keySet(2, [a, b]))
  await acceptKeySet(root, keySet(1, [a]), next, signature(next, a))
  await uninstall(root)
  expect(await readdir(root)).toEqual(['data'])
})
