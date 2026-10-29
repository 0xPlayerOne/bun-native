/** Isolated filesystem observation injection; never changes another test's module cache. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { generateKeyPairSync, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTar } from '../../packages/artifacts/src/tar.ts'
import { sha256, type ArtifactIdentity } from '../../packages/artifacts/src/manifest.ts'

const mode = process.argv[2]
assert.ok(['released', 'held', 'multiple-links', 'symlink', 'directory'].includes(mode ?? ''))
const { lstat, mkdtemp, writeFile, rm, readFile, readdir } = filesystem
const root = await filesystem.realpath(await mkdtemp(join(tmpdir(), 'bunly-lock-observation-')))
const data = new Uint8Array([1, 2, 3])
const archive = createTar([{ path: 'probe', bytes: data }])
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
const manifest = {
  schema: 1,
  identity,
  archive: {
    url: 'https://artifacts.example.test/probe.tar',
    size: archive.length,
    sha256: sha256(archive),
    format: 'ustar',
  },
  files: [{ path: 'probe', size: data.length, sha256: sha256(data), executable: false }],
}
const payload = Buffer.from(JSON.stringify(manifest))
const keys = generateKeyPairSync('ed25519')
const lock = join(root, `${manifest.archive.sha256}.lock`)
const controller = new AbortController()
let observations = 0,
  downloads = 0
try {
  await writeFile(lock, 'other resolver owns this lock', { mode: 0o600 })
  mock.module('node:fs/promises', () => ({
    ...filesystem,
    lstat: async (...args: Parameters<typeof lstat>) => {
      const result = await lstat(...args)
      if (args[0] === lock) {
        observations++
        assert.equal(downloads, 0, 'A lock observation cannot authorize a download')
        // Model lookup retaining the old inode while its owner unlinks it.
        // The next exclusive creation must still independently win ownership.
        result.nlink = mode === 'multiple-links' ? 2 : 0
        if (mode === 'symlink') result.isSymbolicLink = () => true
        if (mode === 'directory') result.isFile = () => false
        if (mode === 'released') await rm(lock)
        else if (mode === 'held' && observations === 3)
          controller.abort(new Error('cancel bounded lock waiter'))
      }
      return result
    },
  }))
  const { resolveArtifact } = await import('../../packages/artifacts/src/cache.ts')
  const operation = resolveArtifact({
    envelope: {
      keyId: 'test',
      payload: payload.toString('base64'),
      signature: sign(null, payload, keys.privateKey).toString('base64'),
    },
    trustRoots: { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    expected: identity,
    cacheRoot: root,
    allowedOrigins: ['https://artifacts.example.test'],
    timeoutMs: 2000,
    signal: controller.signal,
    fetcher: async () => {
      downloads++
      return new Response(archive)
    },
  })
  if (mode === 'released') {
    const result = await operation
    assert.equal(result.cacheHit, false)
    assert.equal(observations, 1)
    assert.equal(downloads, 1)
    assert.deepEqual(await readdir(root), [manifest.archive.sha256])
  } else {
    await assert.rejects(
      operation,
      mode === 'held' ? /cancel bounded lock waiter/ : /private regular file/
    )
    assert.equal(observations, mode === 'held' ? 3 : 1)
    assert.equal(downloads, 0)
    assert.equal(await readFile(lock, 'utf8'), 'other resolver owns this lock')
  }
  console.log(JSON.stringify({ mode, passed: true, observations, downloads }))
} finally {
  await rm(root, { recursive: true, force: true })
}
