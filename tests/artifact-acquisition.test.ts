import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import {
  ArtifactError,
  createTar,
  inspectArtifact,
  resolveArtifact,
  sha256,
  verifyManifest,
} from '../packages/artifacts/src/index.ts'
import type {
  ArtifactIdentity,
  ArtifactManifest,
  ResolveOptions,
  SignedManifest,
} from '../packages/artifacts/src/index.ts'

const keys = generateKeyPairSync('ed25519')
const trustRoots = { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
const identity: ArtifactIdentity = {
  kind: 'host-probe',
  version: '0.1.0-dev.0',
  abi: 1,
  backend: 'none',
  target: 'linux-x64',
  bun: '1.4.3',
  nativeToolchain: 'rust-1.85.1',
  cef: null,
}
function signed(value: unknown): SignedManifest {
  const payload = Buffer.from(JSON.stringify(value))
  return {
    keyId: 'fixture',
    payload: payload.toString('base64'),
    signature: sign(null, payload, keys.privateKey).toString('base64'),
  }
}
function fixture(cacheRoot: string): {
  options: ResolveOptions
  archive: Uint8Array<ArrayBuffer>
  manifest: ArtifactManifest
} {
  const data = Buffer.alloc(192 * 1024 + 7, 73)
  const archive = createTar([{ path: 'bin/probe', bytes: data }])
  const manifest: ArtifactManifest = {
    schema: 1,
    identity,
    archive: {
      url: 'https://artifacts.example.test/probe.tar',
      size: archive.length,
      sha256: sha256(archive),
      format: 'ustar',
    },
    files: [{ path: 'bin/probe', size: data.length, sha256: sha256(data), executable: true }],
  }
  return {
    archive,
    manifest,
    options: {
      envelope: signed(manifest),
      trustRoots,
      expected: identity,
      cacheRoot,
      allowedOrigins: ['https://artifacts.example.test'],
      fetcher: async () => new Response(archive),
    },
  }
}
function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ArtifactError && error.code === code
}
async function withCache(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bunly-acquisition-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Resolver exceeded test bound')), 1000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const timedOut = (error: unknown): boolean =>
  error instanceof Error && error.name === 'TimeoutError'

describe('artifact acquisition boundaries', () => {
  it('requires a complete expected identity even for untyped callers', () => {
    const { options } = fixture('unused')
    for (const expected of [{}, { kind: 'host-probe' }, { ...identity, extra: 'ignored' }]) {
      assert.throws(() =>
        verifyManifest(options.envelope, trustRoots, expected as ArtifactIdentity)
      )
    }
  })
  it('wraps malformed signed archive URLs as manifest errors', () => {
    const { manifest } = fixture('unused')
    assert.throws(
      () =>
        verifyManifest(
          signed({ ...manifest, archive: { ...manifest.archive, url: 'not a URL' } }),
          trustRoots,
          identity
        ),
      hasCode('BAD_MANIFEST')
    )
  })
  it('rejects unlisted empty directories instead of trusting their existence', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      const first = await resolveArtifact(options)
      await mkdir(join(first.directory, 'not-in-manifest', 'nested'), { recursive: true })
      await assert.rejects(
        resolveArtifact({ ...options, offline: true }),
        hasCode('INTEGRITY_ERROR')
      )
    }))
  it('does not accept files hard-linked outside the private entry', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      const first = await resolveArtifact(options)
      await link(join(first.directory, 'bin/probe'), join(root, 'external-alias'))
      await assert.rejects(resolveArtifact({ ...options, offline: true }), hasCode('UNSAFE_CACHE'))
      assert.equal((await readFile(join(root, 'external-alias'))).length, 192 * 1024 + 7)
    }))
  it('honors cancellation that arrives while an offline cache hit is being checked', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      await resolveArtifact(options)
      const controller = new AbortController()
      const reason = new Error('cancel cache verification')
      const pending = resolveArtifact({ ...options, offline: true, signal: controller.signal })
      controller.abort(reason)
      await assert.rejects(pending, (error) => error === reason)
      assert.equal((await resolveArtifact({ ...options, offline: true })).cacheHit, true)
    }))
  it('fails disk preflight before fetching and releases its owned lock', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      let downloads = 0
      await assert.rejects(
        resolveArtifact({
          ...options,
          reserveBytes: Number.MAX_SAFE_INTEGER,
          fetcher: async () => {
            downloads++
            throw new Error('must not fetch')
          },
        }),
        hasCode('INSUFFICIENT_DISK_SPACE')
      )
      assert.equal(downloads, 0)
      assert.deepEqual(await readdir(root), [])
      assert.equal((await resolveArtifact(options)).cacheHit, false)
    }))
  it('reuses verified cache hits without enforcing an extraction budget or fetching again', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      const first = await resolveArtifact(options)
      const reused = await resolveArtifact({
        ...options,
        reserveBytes: Number.MAX_SAFE_INTEGER,
        offline: true,
        fetcher: async () => {
          throw new Error('offline cache must not download')
        },
      })
      assert.equal(reused.cacheHit, true)
      assert.equal(reused.directory, first.directory)
    }))
  it('rejects invalid budgets and deadlines before creating cache state', async () =>
    withCache(async (root) => {
      const { options } = fixture(join(root, 'never-created'))
      for (const reserveBytes of [-1, 1.5, NaN, Infinity])
        await assert.rejects(
          resolveArtifact({ ...options, reserveBytes }),
          hasCode('INVALID_ARGUMENT')
        )
      for (const timeoutMs of [0, -1, 1.5, Infinity, 600001])
        await assert.rejects(
          resolveArtifact({ ...options, timeoutMs }),
          hasCode('INVALID_ARGUMENT')
        )
      assert.deepEqual(await readdir(root), [])
    }))
  it('bounds a fetcher which never resolves or observes the abort signal', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      await assert.rejects(
        bounded(
          resolveArtifact({ ...options, timeoutMs: 100, fetcher: () => new Promise(() => {}) })
        ),
        timedOut
      )
      assert.deepEqual(await readdir(root), [])
    }))
  it('cancels a late response from a fetcher after the deadline', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      let respond!: (response: Response) => void
      let cancelled = false
      const pending = resolveArtifact({
        ...options,
        timeoutMs: 100,
        fetcher: () =>
          new Promise((resolve) => {
            respond = resolve
          }),
      })
      await assert.rejects(bounded(pending), timedOut)
      respond(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true
            },
          })
        )
      )
      await delay(5)
      assert.equal(cancelled, true)
      assert.deepEqual(await readdir(root), [])
    }))
  it('bounds a stalled body even when underlying cancellation never resolves', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      let cancelled = false
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1))
          },
          cancel() {
            cancelled = true
            return new Promise<void>(() => {})
          },
        })
      )
      await assert.rejects(
        bounded(resolveArtifact({ ...options, timeoutMs: 100, fetcher: async () => response })),
        timedOut
      )
      assert.equal(cancelled, true)
      assert.deepEqual(await readdir(root), [])
      assert.equal((await resolveArtifact(options)).cacheHit, false)
    }))
  it('rejects redirected responses from fetchers that followed redirects internally', async () =>
    withCache(async (root) => {
      const { options, archive } = fixture(root)
      const response = new Response(archive)
      Object.defineProperty(response, 'redirected', { value: true })
      await assert.rejects(
        resolveArtifact({ ...options, fetcher: async () => response }),
        hasCode('UNTRUSTED_ORIGIN')
      )
      assert.deepEqual(await readdir(root), [])
    }))
  it('accepts allowed manual redirects but rejects malformed ones', async () =>
    withCache(async (root) => {
      const { options, archive } = fixture(root)
      let requests = 0
      const result = await resolveArtifact({
        ...options,
        fetcher: async (url) => {
          requests++
          return url.endsWith('probe.tar')
            ? new Response(null, { status: 302, headers: { location: '/pinned.tar' } })
            : new Response(archive)
        },
      })
      assert.equal(requests, 2)
      assert.equal(result.cacheHit, false)
      await rm(result.directory, { recursive: true })
      await assert.rejects(
        resolveArtifact({
          ...options,
          fetcher: async () =>
            new Response(null, { status: 302, headers: { location: 'http://[' } }),
        }),
        hasCode('DOWNLOAD_FAILED')
      )
      assert.deepEqual(await readdir(root), [])
    }))
  it('rejects non-decimal content lengths even when Number would accept them', async () =>
    withCache(async (root) => {
      const { options, archive } = fixture(root)
      for (const value of [
        `${archive.length}.0`,
        `+${archive.length}`,
        `0x${archive.length.toString(16)}`,
      ]) {
        await assert.rejects(
          resolveArtifact({
            ...options,
            fetcher: async () => new Response(archive, { headers: { 'content-length': value } }),
          }),
          hasCode('INTEGRITY_ERROR')
        )
      }
      assert.deepEqual(await readdir(root), [])
    }))
  it('never removes a different resolver’s lock on wait cancellation', async () =>
    withCache(async (root) => {
      const { options, manifest } = fixture(root)
      const lock = join(root, `${manifest.archive.sha256}.lock`)
      await writeFile(lock, 'existing owner', { mode: 0o600 })
      await assert.rejects(bounded(resolveArtifact({ ...options, timeoutMs: 100 })), timedOut)
      assert.equal(await readFile(lock, 'utf8'), 'existing owner')
    }))
  it('rejects a non-file lock instead of waiting on an unsafe path', async () =>
    withCache(async (root) => {
      const { options, manifest } = fixture(root)
      await mkdir(join(root, `${manifest.archive.sha256}.lock`))
      await assert.rejects(
        bounded(resolveArtifact({ ...options, timeoutMs: 100 })),
        hasCode('UNSAFE_CACHE')
      )
    }))
  it('keeps cancelled and surviving concurrent consumers independent', async () =>
    withCache(async (root) => {
      const { options, archive } = fixture(root)
      const controller = new AbortController()
      let started!: () => void
      let finish!: () => void
      const began = new Promise<void>((resolve) => {
        started = resolve
      })
      const release = new Promise<void>((resolve) => {
        finish = resolve
      })
      let downloads = 0
      const shared: ResolveOptions = {
        ...options,
        fetcher: async () => {
          downloads++
          if (downloads === 1) {
            started()
            await release
          }
          return new Response(archive)
        },
      }
      const cancelled = resolveArtifact({ ...shared, signal: controller.signal })
      await began
      const survivor = resolveArtifact(shared)
      controller.abort(new Error('cancel first consumer'))
      finish()
      await assert.rejects(cancelled, /cancel first consumer/)
      const result = await survivor
      assert.equal(result.cacheHit, false)
      assert.equal(downloads, 2)
      assert.deepEqual(await readdir(root), [sha256(archive)])
    }))
})

describe('read-only artifact inspection', () => {
  it('reports missing entries without creating a root, lock, stage, or downloading', async () =>
    withCache(async (root) => {
      const { options, manifest } = fixture(join(root, 'missing-root'))
      const result = await inspectArtifact(options)
      assert.equal(result.status, 'missing')
      assert.equal(result.directory, join(options.cacheRoot, manifest.archive.sha256))
      assert.deepEqual(await readdir(root), [])
    }))
  it('verifies the signed inventory without changing a cache hit', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      const cached = await resolveArtifact(options)
      const before = await readdir(root)
      assert.deepEqual(await inspectArtifact(options), {
        directory: cached.directory,
        status: 'verified',
      })
      assert.deepEqual(await readdir(root), before)
    }))
  it('reports a missing published entry while leaving another acquisition lock untouched', async () =>
    withCache(async (root) => {
      const { options, manifest } = fixture(root)
      const name = `${manifest.archive.sha256}.lock`
      await writeFile(join(root, name), 'owner', { mode: 0o600 })
      assert.equal((await inspectArtifact(options)).status, 'missing')
      assert.equal(await readFile(join(root, name), 'utf8'), 'owner')
    }))
  it('fails on corruption rather than reporting a present directory as verified', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      const cached = await resolveArtifact(options)
      await writeFile(join(cached.directory, 'bin/probe'), Buffer.alloc(192 * 1024 + 7, 72))
      await assert.rejects(inspectArtifact(options), hasCode('INTEGRITY_ERROR'))
    }))
  it('honors cancellation and rejects an incomplete caller identity before inspection', async () =>
    withCache(async (root) => {
      const { options } = fixture(root)
      const reason = new Error('cancel inspection')
      await assert.rejects(
        inspectArtifact({ ...options, signal: AbortSignal.abort(reason) }),
        (error) => error === reason
      )
      await assert.rejects(
        inspectArtifact({ ...options, expected: {} as ArtifactIdentity }),
        hasCode('BAD_MANIFEST')
      )
      assert.deepEqual(await readdir(root), [])
    }))
})
