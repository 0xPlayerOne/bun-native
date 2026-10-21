/** Real bounded-volume ENOSPC qualification; transport is an injected local fixture, not HTTPS evidence. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { packageCefRuntime } from '../packages/artifacts/src/cef-pack.ts'
import { resolveCefRuntime } from '../packages/artifacts/src/cef-cache.ts'
import type { CefRuntimeIdentity } from '../packages/artifacts/src/cef-manifest.ts'

export function separateBoundedVolume(
  parentDevice: number,
  volumeDevice: number,
  totalBytes: bigint
): void {
  if (
    !Number.isSafeInteger(parentDevice) ||
    !Number.isSafeInteger(volumeDevice) ||
    parentDevice === volumeDevice ||
    totalBytes < 32n * 1024n ** 2n ||
    totalBytes > 128n * 1024n ** 2n
  )
    throw new Error('A separate 32–128 MiB disposable filesystem is required')
}
async function fillVolume(path: string): Promise<number> {
  const file = await open(path, 'wx', 0o600)
  let written = 0,
    full = false
  try {
    const block = Buffer.alloc(1024 * 1024, 19)
    while (written < 128 * 1024 * 1024) {
      try {
        const result = await file.write(block)
        assert.ok(result.bytesWritten > 0)
        written += result.bytesWritten
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error
        full = true
        break
      }
    }
    assert.ok(full, 'The disposable filesystem did not report real ENOSPC')
    const size = (await file.stat()).size
    assert.ok(size > 1024 * 1024)
    // Leave space for the tiny compressed download and metadata, but not extraction.
    await file.truncate(size - 512 * 1024)
    await file.sync()
    return size
  } finally {
    await file.close()
  }
}
async function qualify(work: string, volume: string) {
  const stats = await statfs(volume, { bigint: true })
  separateBoundedVolume(
    (await stat(work)).dev,
    (await stat(volume)).dev,
    stats.blocks * stats.bsize
  )
  const payload = join(work, 'payload'),
    cacheRoot = join(volume, 'runtime-cache'),
    filler = join(volume, 'competing-writer')
  await mkdir(payload, { mode: 0o700 })
  await mkdir(join(payload, 'resources'), { mode: 0o755 })
  for (const name of ['host', 'bun', 'helper']) {
    await writeFile(join(payload, name), 'synthetic runtime component; never executed', {
      mode: 0o755,
    })
    await chmod(join(payload, name), 0o755)
  }
  await writeFile(
    join(payload, 'resources/runtime.json'),
    JSON.stringify({ schema: 1, protocol: 1, bun_version: '1.4.3', cef_version: '154.0.34' })
  )
  await writeFile(join(payload, 'LICENSE'), 'Synthetic storage qualification only')
  await writeFile(join(payload, 'large.bin'), Buffer.alloc(16 * 1024 * 1024, 81))
  const identity: CefRuntimeIdentity = {
    kind: 'cef-runtime',
    version: '0.1.0-dev.0',
    abi: 1,
    target: 'darwin-arm64',
    bun: '1.4.3',
    cef: '154.0.34',
    chromium: '154.0.8037.98',
    cefRs: '163744c8286d5f593d89202c7807751a7898db28',
    nativeToolchain: 'rust-1.91.0',
  }
  const archive = join(work, 'fixture.tar.gz')
  const manifest = await packageCefRuntime({
    directory: payload,
    output: archive,
    url: 'https://fixture.invalid/runtime.tar.gz',
    identity,
    layout: { executable: 'host', bun: 'bun', resources: 'resources', helpers: ['helper'] },
    notices: ['LICENSE'],
  })
  const keys = generateKeyPairSync('ed25519'),
    bytes = Buffer.from(JSON.stringify(manifest))
  const envelope = {
    keyId: 'storage-fixture',
    payload: bytes.toString('base64'),
    signature: sign(null, bytes, keys.privateKey).toString('base64'),
  }
  const options = {
    envelope,
    trustRoots: {
      'storage-fixture': keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
    expected: identity,
    cacheRoot,
    allowedOrigins: ['https://fixture.invalid'],
    reserveBytes: 0,
    timeoutMs: 30000,
  }
  let requests = 0,
    fillerBytes = 0
  try {
    await assert.rejects(
      resolveCefRuntime({
        ...options,
        fetcher: async () => {
          requests++
          fillerBytes = await fillVolume(filler)
          return new Response(Bun.file(archive))
        },
      }),
      (error: unknown) => (error as { code?: string }).code === 'INSUFFICIENT_DISK_SPACE'
    )
    assert.equal(requests, 1, 'Disk was filled only after the capacity preflight')
    assert.deepEqual(
      (await readdir(cacheRoot)).filter((name) => !name.endsWith('.lock')),
      []
    )
    await assert.rejects(
      resolveCefRuntime({
        ...options,
        fetcher: async () => {
          requests++
          throw new Error('Low-disk preflight must reject before transport')
        },
      }),
      (error: unknown) => (error as { code?: string }).code === 'INSUFFICIENT_DISK_SPACE'
    )
    assert.equal(requests, 1)
  } finally {
    await rm(filler, { force: true })
  }
  const recovered = await resolveCefRuntime({
    ...options,
    fetcher: async () => {
      requests++
      return new Response(Bun.file(archive))
    },
  })
  assert.equal(recovered.cacheHit, false)
  const restored = await readFile(join(recovered.directory, 'large.bin'))
  assert.equal(restored.length, 16 * 1024 * 1024)
  const member = manifest.members.find((f) => f.path === 'large.bin')
  assert.ok(member?.type === 'file')
  assert.equal(createHash('sha256').update(restored).digest('hex'), member.sha256)
  const cached = await resolveCefRuntime({ ...options, offline: true })
  assert.equal(cached.cacheHit, true)
  return {
    schema: 1,
    passed: true,
    profile: 'real-disposable-filesystem-enospc-with-local-fixture-transport',
    volumeBytes: String(stats.blocks * stats.bsize),
    fillerBytes,
    archiveBytes: manifest.archive.size,
    payloadBytes: restored.length,
    requests,
    preflightRejectedBeforeFetch: true,
    partialWriteNeverPublished: true,
    stagingCleaned: true,
    recoveryPassed: true,
    offlineReusePassed: true,
    limitations: [
      'Synthetic runtime contents, not another native CEF execution',
      'Injected transport; separate full-runtime qualifier owns HTTPS acceptance',
    ],
  }
}
if (import.meta.main) {
  const [work, volume] = process.argv.slice(2)
  if (process.platform !== 'darwin' || !work || !volume || process.argv.length !== 4)
    throw new Error(
      'Usage: bun scripts/qualify-cef-storage.ts <private-workspace> <disposable-volume>'
    )
  try {
    console.log(JSON.stringify(await qualify(resolve(work), resolve(volume))))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
