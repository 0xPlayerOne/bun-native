import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ArtifactError,
  createTar,
  readTar,
  resolveArtifact,
  safeRelativePath,
  sha256,
  verifyManifest,
} from '../packages/artifacts/src/index.ts'
import type {
  ArtifactIdentity,
  ArtifactManifest,
  SignedManifest,
} from '../packages/artifacts/src/index.ts'
const keys = generateKeyPairSync('ed25519')
const trustRoots = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
const identity: ArtifactIdentity = {
  kind: 'host-probe',
  version: '0.1.0-dev.0',
  abi: 1,
  backend: 'none',
  target: 'linux-x64',
  bun: '1.4.4',
  nativeToolchain: 'rust-1.85.1',
  cef: null,
}
function envelope(manifest: unknown): SignedManifest {
  const payload = Buffer.from(JSON.stringify(manifest))
  return {
    keyId: 'test',
    payload: payload.toString('base64'),
    signature: sign(null, payload, keys.privateKey).toString('base64'),
  }
}
function fixture() {
  const bytes = Buffer.from('native probe fixture')
  const tar = createTar([{ path: 'bin/probe', bytes }])
  const manifest: ArtifactManifest = {
    schema: 1,
    identity,
    archive: {
      url: 'https://artifacts.example.test/probe.tar',
      size: tar.length,
      sha256: sha256(tar),
      format: 'ustar',
    },
    files: [{ path: 'bin/probe', size: bytes.length, sha256: sha256(bytes), executable: true }],
  }
  return { bytes, tar, manifest }
}
const hasCode = (code: string) => (e: unknown) => e instanceof ArtifactError && e.code === code
async function withCache(fn: (cacheRoot: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'bunly-test-'))
  try {
    await fn(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}
function options(cacheRoot: string, f = fixture()) {
  return {
    envelope: envelope(f.manifest),
    trustRoots,
    expected: identity,
    cacheRoot,
    allowedOrigins: ['https://artifacts.example.test'],
    fetcher: async () => new Response(f.tar),
  }
}
describe('signed artifact manifests', () => {
  it('accepts an independently trusted signature and exact identity', () => {
    const f = fixture()
    assert.deepEqual(verifyManifest(envelope(f.manifest), trustRoots, identity), f.manifest)
  })
  it('rejects an unknown key or tampered signature', () => {
    const e = envelope(fixture().manifest)
    assert.throws(
      () => verifyManifest({ ...e, keyId: 'unknown' }, trustRoots, identity),
      hasCode('UNTRUSTED_KEY')
    )
    assert.throws(
      () =>
        verifyManifest(
          { ...e, signature: Buffer.alloc(64).toString('base64') },
          trustRoots,
          identity
        ),
      hasCode('BAD_SIGNATURE')
    )
  })
  it('rejects wrong ABI/runtime/platform/version before download', () => {
    for (const changed of [{ bun: '1.4.0' }, { target: 'darwin-arm64' }, { version: '0.2.0' }])
      assert.throws(
        () =>
          verifyManifest(envelope(fixture().manifest), trustRoots, {
            ...identity,
            ...changed,
          } as ArtifactIdentity),
        hasCode('IDENTITY_MISMATCH')
      )
  })
  it('rejects unsigned field mutation', () => {
    const e = envelope(fixture().manifest)
    assert.throws(
      () =>
        verifyManifest(
          { ...e, payload: Buffer.from('{}').toString('base64') },
          trustRoots,
          identity
        ),
      hasCode('BAD_SIGNATURE')
    )
  })
  it('rejects traversal and platform aliases', () => {
    for (const p of [
      '../x',
      '/x',
      'C:/x',
      'a\\x',
      'a/../x',
      'a//x',
      'con.txt',
      'x.',
      'x ',
      'a/./x',
      'x\0y',
    ])
      assert.throws(() => safeRelativePath(p), hasCode('UNSAFE_PATH'))
  })
  it('rejects overlapping/case-colliding file names', () => {
    const f = fixture()
    for (const path of ['BIN/probe', 'bin/probe/child'])
      assert.throws(
        () =>
          verifyManifest(
            envelope({
              ...f.manifest,
              files: [...f.manifest.files, { ...f.manifest.files[0], path }],
            }),
            trustRoots,
            identity
          ),
        hasCode('BAD_MANIFEST')
      )
  })
})
describe('restricted archive format', () => {
  it('is deterministic and round trips binary data', () => {
    const files = [{ path: 'a', bytes: Uint8Array.of(0, 255, 13, 10) }]
    assert.deepEqual(createTar(files), createTar(files))
    assert.deepEqual(
      readTar(createTar(files)).map((f) => ({ path: f.path, bytes: [...f.bytes] })),
      files.map((f) => ({ path: f.path, bytes: [...f.bytes] }))
    )
  })
  it('rejects truncated and corrupted archives', () => {
    const f = fixture()
    assert.throws(() => readTar(f.tar.subarray(0, 800)))
    const bad = f.tar.slice()
    bad[0] = 100
    assert.throws(() => readTar(bad), hasCode('BAD_ARCHIVE'))
  })
  it('rejects symlinks and devices even with a valid header checksum', () => {
    for (const type of [49, 50, 51, 52, 54, 120]) {
      const tar = fixture().tar.slice()
      tar[156] = type
      tar.fill(32, 148, 156)
      const sum = tar.subarray(0, 512).reduce((s, n) => s + n, 0)
      tar.set(Buffer.from(sum.toString(8).padStart(6, '0') + '\0 '), 148)
      assert.throws(() => readTar(tar), hasCode('UNSAFE_ARCHIVE'))
    }
  })
})
describe('verified artifact cache', () => {
  it('downloads once and verifies offline reuse', async () =>
    withCache(async (root) => {
      const f = fixture()
      let calls = 0
      const o = {
        ...options(root, f),
        fetcher: async () => {
          calls++
          return new Response(f.tar)
        },
      }
      const first = await resolveArtifact(o)
      assert.equal(first.cacheHit, false)
      assert.deepEqual(await readFile(join(first.directory, 'bin/probe')), f.bytes)
      const second = await resolveArtifact({ ...o, offline: true })
      assert.equal(second.cacheHit, true)
      assert.equal(calls, 1)
    }))
  it('reports missing offline artifacts without invoking compilers', async () =>
    withCache(async (root) => {
      await assert.rejects(
        resolveArtifact({ ...options(root), offline: true }),
        hasCode('MISSING_ARTIFACT')
      )
    }))
  it('serializes concurrent consumers', async () =>
    withCache(async (root) => {
      let calls = 0
      const f = fixture()
      const o = {
        ...options(root, f),
        fetcher: async () => {
          calls++
          await new Promise((r) => setTimeout(r, 30))
          return new Response(f.tar)
        },
      }
      const results = await Promise.all([
        resolveArtifact(o),
        resolveArtifact(o),
        resolveArtifact(o),
      ])
      assert.equal(calls, 1)
      assert.equal(new Set(results.map((r) => r.directory)).size, 1)
    }))
  it('detects poisoned cache bytes', async () =>
    withCache(async (root) => {
      const o = options(root)
      const r = await resolveArtifact(o)
      await writeFile(join(r.directory, 'bin/probe'), 'corrupt')
      await assert.rejects(resolveArtifact({ ...o, offline: true }), hasCode('INTEGRITY_ERROR'))
    }))
  it('rejects extra cached files', async () =>
    withCache(async (root) => {
      const o = options(root)
      const r = await resolveArtifact(o)
      await writeFile(join(r.directory, 'extra'), 'x')
      await assert.rejects(resolveArtifact(o), hasCode('INTEGRITY_ERROR'))
    }))
  it(
    'rejects cache symlinks without following them',
    { skip: process.platform === 'win32' },
    async () =>
      withCache(async (root) => {
        const o = options(root)
        const r = await resolveArtifact(o)
        await rm(join(r.directory, 'bin/probe'))
        await symlink('/etc/passwd', join(r.directory, 'bin/probe'))
        await assert.rejects(resolveArtifact(o), hasCode('UNSAFE_CACHE'))
      })
  )
  it('rejects corruption and cleans failed download state', async () =>
    withCache(async (root) => {
      const o = {
        ...options(root),
        fetcher: async () => new Response(Buffer.alloc(fixture().tar.length)),
      }
      await assert.rejects(resolveArtifact(o), hasCode('INTEGRITY_ERROR'))
      assert.deepEqual(await readdir(root), [])
    }))
  it('rejects oversized bodies and incorrect declared length', async () =>
    withCache(async (root) => {
      for (const response of [
        () => new Response(new Uint8Array(fixture().tar.length + 1)),
        () => new Response(fixture().tar, { headers: { 'content-length': '1' } }),
      ])
        await assert.rejects(
          resolveArtifact({ ...options(root), fetcher: async () => response() }),
          hasCode('INTEGRITY_ERROR')
        )
    }))
  it('prevents redirect origin escape and plaintext download', async () =>
    withCache(async (root) => {
      for (const location of ['https://other.test/a', 'http://artifacts.example.test/a'])
        await assert.rejects(
          resolveArtifact({
            ...options(root),
            fetcher: async () => new Response(null, { status: 302, headers: { location } }),
          }),
          hasCode('UNTRUSTED_ORIGIN')
        )
    }))
  it('cleans interrupted streams and honors pre-cancellation', async () =>
    withCache(async (root) => {
      await assert.rejects(resolveArtifact({ ...options(root), signal: AbortSignal.abort() }))
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(Uint8Array.of(1))
          c.error(new Error('interrupted'))
        },
      })
      await assert.rejects(
        resolveArtifact({ ...options(root), fetcher: async () => new Response(stream) })
      )
      assert.deepEqual(await readdir(root), [])
    }))
  it('rejects a signed archive whose members differ from the inventory', async () =>
    withCache(async (root) => {
      const f = fixture()
      const tar = createTar([{ path: 'bin/other', bytes: f.bytes }])
      const manifest = {
        ...f.manifest,
        archive: { ...f.manifest.archive, sha256: sha256(tar), size: tar.length },
      }
      await assert.rejects(
        resolveArtifact({
          ...options(root),
          envelope: envelope(manifest),
          fetcher: async () => new Response(tar),
        }),
        hasCode('INTEGRITY_ERROR')
      )
    }))
})
