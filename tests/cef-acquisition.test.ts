import { test, expect } from 'bun:test'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, chmod, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import {
  parseCefManifest,
  verifyCefManifest,
  type CefMember,
  type CefRuntimeIdentity,
} from '../packages/artifacts/src/cef-manifest.ts'
import { runtimeTarHeader, packageCefRuntime } from '../packages/artifacts/src/cef-pack.ts'
import {
  resolveCefRuntime,
  removeCefRuntime,
  withCefRuntime,
} from '../packages/artifacts/src/cef-cache.ts'
import { kernelLock } from '../packages/artifacts/src/kernel-lock.ts'
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const identity: CefRuntimeIdentity = {
  kind: 'cef-runtime',
  version: '0.1.0',
  abi: 1,
  target: 'darwin-arm64',
  bun: '1.4.4',
  cef: '156.0.7',
  chromium: '156.0.8078.17',
  cefRs: 'a'.repeat(40),
  nativeToolchain: 'rust-1.91.0',
}
const keys = generateKeyPairSync('ed25519'),
  rootPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
function envelope(m: unknown) {
  const bytes = Buffer.from(JSON.stringify(m))
  return {
    keyId: 'fixture',
    payload: bytes.toString('base64'),
    signature: sign(null, bytes, keys.privateKey).toString('base64'),
  }
}
function fixture(extra?: { path: string; bytes: Buffer }) {
  const files = [
    { path: 'host', bytes: Buffer.from('host') },
    { path: 'helper', bytes: Buffer.from('helper') },
    { path: 'resources/bun', bytes: Buffer.from('bun') },
    {
      path: 'resources/runtime.json',
      bytes: Buffer.from(
        JSON.stringify({ schema: 1, protocol: 1, bun_version: '1.4.4', cef_version: '156.0.7' })
      ),
    },
    { path: 'LICENSE', bytes: Buffer.from('fixture-only-not-a-browser') },
    ...(extra ? [extra] : []),
  ]
  const members: CefMember[] = [
    { path: 'resources', type: 'directory', mode: 0o700 },
    ...files.map((f) => ({
      path: f.path,
      type: 'file' as const,
      mode: f.path.includes('.json') ? 0o600 : 0o700,
      size: f.bytes.length,
      sha256: digest(f.bytes),
    })),
    { path: 'current', type: 'symlink', target: 'resources' },
  ]
  const tar = Buffer.concat([
    ...members.flatMap((m) => {
      const result = [runtimeTarHeader(m)]
      if (m.type === 'file') {
        result.push(files.find((f) => f.path === m.path)!.bytes)
        const pad = (512 - (m.size % 512)) % 512
        if (pad) result.push(Buffer.alloc(pad))
      }
      return result
    }),
    Buffer.alloc(1024),
  ])
  const bytes = gzipSync(tar),
    manifest = parseCefManifest({
      schema: 2,
      identity,
      archive: {
        url: 'https://runtime.invalid/runtime.tar.gz',
        size: bytes.length,
        sha256: digest(bytes),
        tarBytes: tar.length,
        format: 'ustar-gzip',
      },
      members,
      layout: {
        executable: 'host',
        bun: 'resources/bun',
        resources: 'resources',
        helpers: ['helper'],
      },
      notices: ['LICENSE'],
      locales: 'all',
      debugSymbols: false,
    })
  return { bytes, manifest, tar, files }
}
function options(root: string, f = fixture()) {
  return {
    cacheRoot: root,
    envelope: envelope(f.manifest),
    trustRoots: { fixture: rootPem },
    expected: identity,
    allowedOrigins: ['https://runtime.invalid'],
    fetcher: async () => new Response(new Uint8Array(f.bytes)),
  }
}
async function temp(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'bunly-cef-cache-'))
  await chmod(root, 0o700)
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
test('complete runtime signature and identity are checked before networking', async () => {
  await temp(async (root) => {
    let requests = 0
    const o = {
      ...options(root),
      fetcher: async () => {
        requests++
        return new Response('unused')
      },
    }
    await expect(
      resolveCefRuntime({
        ...o,
        envelope: { ...o.envelope, signature: Buffer.alloc(64).toString('base64') },
      })
    ).rejects.toThrow('authentication')
    await expect(
      resolveCefRuntime({ ...o, expected: { ...identity, cef: '154.0.35' } })
    ).rejects.toThrow('does not match')
    expect(requests).toBe(0)
  })
})
test('runtime manifest rejects traversal, symlink write-through, aliases, special modes and missing helpers', () => {
  const f = fixture()
  expect(verifyCefManifest(envelope(f.manifest), { fixture: rootPem }, identity).identity.cef).toBe(
    '156.0.7'
  )
  for (const member of [
    { path: '../outside', type: 'file', mode: 0o700, size: 0, sha256: digest(Buffer.alloc(0)) },
    { path: 'HOST', type: 'file', mode: 0o700, size: 0, sha256: digest(Buffer.alloc(0)) },
    { path: 'current/evil', type: 'file', mode: 0o700, size: 0, sha256: digest(Buffer.alloc(0)) },
    { path: 'bad', type: 'symlink', target: '../outside' },
    { path: 'bad', type: 'file', mode: 0o4755, size: 0, sha256: digest(Buffer.alloc(0)) },
    { path: 'bad', type: 'symlink', target: 'bad' },
  ])
    expect(() =>
      parseCefManifest({ ...f.manifest, members: [...f.manifest.members, member] })
    ).toThrow()
  expect(() =>
    parseCefManifest({ ...f.manifest, layout: { ...f.manifest.layout, helpers: ['missing'] } })
  ).toThrow()
})
test('streamed verified acquisition preserves links and reuses offline cache without copying', async () =>
  temp(async (root) => {
    let downloads = 0
    const f = fixture(),
      o = {
        ...options(root, f),
        fetcher: async () => {
          downloads++
          return new Response(new Uint8Array(f.bytes))
        },
      }
    const first = await resolveCefRuntime(o),
      before = await lstat(join(first.directory, 'host'))
    expect(first.cacheHit).toBe(false)
    expect(await readFile(join(first.directory, 'current/bun'), 'utf8')).toBe('bun')
    const second = await resolveCefRuntime({ ...o, offline: true })
    expect(second.cacheHit).toBe(true)
    expect(downloads).toBe(1)
    expect((await lstat(join(second.directory, 'host'))).ino).toBe(before.ino)
    await writeFile(join(first.directory, 'host'), 'evil')
    await expect(resolveCefRuntime({ ...o, offline: true })).rejects.toThrow('Corrupt runtime')
    await removeCefRuntime(o)
    await expect(resolveCefRuntime({ ...o, offline: true })).rejects.toThrow('Offline runtime')
  }))
test('concurrent acquisitions share one publication and persistent lockfile', async () =>
  temp(async (root) => {
    let downloads = 0
    const f = fixture(),
      o = {
        ...options(root, f),
        fetcher: async () => {
          downloads++
          await Bun.sleep(60)
          return new Response(new Uint8Array(f.bytes))
        },
      }
    const [a, b] = await Promise.all([resolveCefRuntime(o), resolveCefRuntime(o)])
    expect(downloads).toBe(1)
    expect([a.cacheHit, b.cacheHit].sort()).toEqual([false, true])
    expect((await lstat(join(root, f.manifest.archive.sha256 + '.lock'))).isFile()).toBe(true)
  }))
test('partial download, unsafe redirect and signed malformed tar never publish a runtime', async () =>
  temp(async (root) => {
    const f = fixture(),
      o = options(root, f)
    await expect(
      resolveCefRuntime({
        ...o,
        fetcher: async () => new Response(new Uint8Array(f.bytes.subarray(0, 15))),
      })
    ).rejects.toThrow('hash/length')
    await expect(
      resolveCefRuntime({
        ...o,
        fetcher: async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://untrusted.invalid/file' },
          }),
      })
    ).rejects.toThrow('origin denied')
    const bad = Buffer.from(f.tar)
    bad[0] = 65
    const data = gzipSync(bad),
      m = {
        ...f.manifest,
        archive: { ...f.manifest.archive, size: data.length, sha256: digest(data) },
      }
    await expect(
      resolveCefRuntime({
        ...o,
        envelope: envelope(m),
        fetcher: async () => new Response(new Uint8Array(data)),
      })
    ).rejects.toThrow('checksum')
    expect(await Bun.file(join(root, f.manifest.archive.sha256, 'host')).exists()).toBe(false)
  }))
test('abandoned staging is recovered only after acquiring the kernel lock', async () =>
  temp(async (root) => {
    const f = fixture(),
      o = options(root, f),
      stage = join(root, '.cef-' + f.manifest.archive.sha256 + '.txn-dead')
    await mkdir(stage)
    await writeFile(join(stage, 'partial'), 'incomplete')
    const result = await resolveCefRuntime(o)
    expect(result.cacheHit).toBe(false)
    expect(await Bun.file(join(stage, 'partial')).exists()).toBe(false)
  }))
test('active runtime leases block cache cleanup and cancelled waiters do not steal a lock', async () =>
  temp(async (root) => {
    const o = options(root)
    await withCefRuntime(o, async (directory) => {
      await expect(removeCefRuntime({ ...o, timeoutMs: 50 })).rejects.toThrow()
      expect(await Bun.file(join(directory, 'host')).exists()).toBe(true)
    })
    await removeCefRuntime(o)
  }))
test('kernel locks survive metadata files but release after an actual process crash', async () =>
  temp(async (root) => {
    const path = join(root, 'kernel.lock'),
      module = join(import.meta.dir, '../packages/artifacts/src/kernel-lock.ts')
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import {kernelLock} from ${JSON.stringify(module)}; await kernelLock(${JSON.stringify(path)},AbortSignal.timeout(5000)); console.log('locked'); await Bun.sleep(30000)`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const reader = child.stdout.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked')
      await expect(kernelLock(path, AbortSignal.timeout(50))).rejects.toThrow()
    } finally {
      child.kill('SIGKILL')
      await child.exited
      reader.releaseLock()
    }
    const release = await kernelLock(path, AbortSignal.timeout(1000))
    await release()
  }))
test(
  'full-browser scale output is streamed beyond the 64 MiB M1 cap',
  async () =>
    temp(async (root) => {
      const f = fixture({ path: 'large.bin', bytes: Buffer.alloc(65 * 1024 * 1024, 81) }),
        o = options(root, f)
      const res = await resolveCefRuntime(o)
      expect((await lstat(join(res.directory, 'large.bin'))).size).toBe(65 * 1024 * 1024)
    }),
  30000
)
test('signed expansion limits and low-disk checks fail without publishing', async () =>
  temp(async (root) => {
    const f = fixture(),
      o = options(root, f)
    await expect(
      resolveCefRuntime({ ...o, reserveBytes: Number.MAX_SAFE_INTEGER })
    ).rejects.toThrow('requires')
    const manifest = { ...f.manifest, archive: { ...f.manifest.archive, tarBytes: 1024 } }
    await expect(resolveCefRuntime({ ...o, envelope: envelope(manifest) })).rejects.toThrow()
  }))

test('cancelled blocked fetch releases its lock and transaction without a retry loop', async () =>
  temp(async (root) => {
    const controller = new AbortController(),
      o = options(root)
    let started!: () => void
    const ready = new Promise<void>((ok) => {
      started = ok
    })
    const task = resolveCefRuntime({
      ...o,
      signal: controller.signal,
      fetcher: async () => {
        started()
        return await new Promise<Response>(() => {})
      },
    })
    await ready
    controller.abort(new Error('cancelled-by-fixture'))
    await expect(task).rejects.toThrow('cancelled-by-fixture')
    const retry = await resolveCefRuntime(o)
    expect(retry.cacheHit).toBe(false)
  }))
test('a stream that fails after bytes arrived cannot leave a reusable cache entry', async () =>
  temp(async (root) => {
    const f = fixture(),
      o = options(root, f)
    let calls = 0
    await expect(
      resolveCefRuntime({
        ...o,
        fetcher: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!calls++) {
                  controller.enqueue(new Uint8Array(f.bytes.subarray(0, 15)))
                  return
                }
                controller.error(new Error('connection-lost'))
              },
            })
          ),
      })
    ).rejects.toThrow('connection-lost')
    const retry = await resolveCefRuntime(o)
    expect(retry.cacheHit).toBe(false)
  }))
for (const grant of [
  { development_origin: 'http://127.0.0.1:8080' },
  { qualification_profile: 'emulated-functional' },
])
  test(
    'a signed development or qualification grant cannot masquerade as a production prebuild: ' +
      Object.keys(grant)[0],
    async () =>
      temp(async (root) => {
        const f = fixture()
        const conf = f.files.find((p) => p.path === 'resources/runtime.json')!
        conf.bytes = Buffer.from(
          JSON.stringify({
            schema: 1,
            protocol: 1,
            bun_version: '1.4.4',
            cef_version: '156.0.7',
            ...grant,
          })
        )
        const members = f.manifest.members.map((m) =>
          m.path === conf.path
            ? {
                ...m,
                type: 'file' as const,
                mode: 0o600,
                size: conf.bytes.length,
                sha256: digest(conf.bytes),
              }
            : m
        )
        const tar = Buffer.concat([
          ...members.flatMap((m) => {
            const parts = [runtimeTarHeader(m)]
            if (m.type === 'file') {
              parts.push(f.files.find((v) => v.path === m.path)!.bytes)
              const pad = (512 - (m.size % 512)) % 512
              if (pad) parts.push(Buffer.alloc(pad))
            }
            return parts
          }),
          Buffer.alloc(1024),
        ])
        const bytes = gzipSync(tar),
          manifest = {
            ...f.manifest,
            members,
            archive: {
              ...f.manifest.archive,
              size: bytes.length,
              sha256: digest(bytes),
              tarBytes: tar.length,
            },
          }
        await expect(
          resolveCefRuntime({
            ...options(root),
            envelope: envelope(manifest),
            fetcher: async () => new Response(new Uint8Array(bytes)),
          })
        ).rejects.toThrow('enables development')
      })
  )
test('runtime directory permission tampering is rejected before reuse', async () =>
  temp(async (root) => {
    if (process.platform === 'win32') return // POSIX mode permissions are not a Windows security model.
    const o = options(root),
      res = await resolveCefRuntime(o)
    await chmod(join(res.directory, 'resources'), 0o777)
    await expect(resolveCefRuntime({ ...o, offline: true })).rejects.toThrow('directory')
  }))

test('native helpers must be executable and unique in the signed layout', () => {
  const f = fixture()
  expect(() =>
    parseCefManifest({
      ...f.manifest,
      layout: { ...f.manifest.layout, helpers: ['helper', 'helper'] },
    })
  ).toThrow('Duplicate native helper')
  expect(() =>
    parseCefManifest({
      ...f.manifest,
      members: f.manifest.members.map((m) => (m.path === 'helper' ? { ...m, mode: 0o644 } : m)),
    })
  ).toThrow('executable native helper')
})
test('packager roundtrip preserves the inspected runtime and refuses existing output', async () =>
  temp(async (root) => {
    const f = fixture(),
      o = options(root, f),
      installed = await resolveCefRuntime(o),
      output = join(root, 'packed.tar.gz')
    const manifest = await packageCefRuntime({
      directory: installed.directory,
      output,
      url: f.manifest.archive.url,
      identity,
      layout: f.manifest.layout,
      notices: f.manifest.notices,
    })
    const bytes = await readFile(output)
    expect(digest(bytes)).toBe(manifest.archive.sha256)
    expect(bytes.length).toBe(manifest.archive.size)
    await expect(
      packageCefRuntime({
        directory: installed.directory,
        output,
        url: f.manifest.archive.url,
        identity,
        layout: f.manifest.layout,
        notices: f.manifest.notices,
      })
    ).rejects.toThrow()
    expect(digest(await readFile(output))).toBe(manifest.archive.sha256)
    const second = await resolveCefRuntime({
      ...o,
      cacheRoot: join(root, 'roundtrip'),
      envelope: envelope(manifest),
      fetcher: async () => new Response(new Uint8Array(bytes)),
    })
    expect(await readFile(join(second.directory, 'current/bun'), 'utf8')).toBe('bun')
  }))
test('archive output cannot reenter the artifact through an ancestor alias', async () =>
  temp(async (root) => {
    const f = fixture(),
      installed = await resolveCefRuntime(options(root, f)),
      alias = join(root, 'alias')
    await symlink(installed.directory, alias, 'dir')
    await expect(
      packageCefRuntime({
        directory: installed.directory,
        output: join(alias, 'recursive.tar.gz'),
        url: f.manifest.archive.url,
        identity,
        layout: f.manifest.layout,
        notices: f.manifest.notices,
      })
    ).rejects.toThrow('include itself')
    expect(await Bun.file(join(installed.directory, 'recursive.tar.gz')).exists()).toBe(false)
  }))
test('separate debug symbols cannot be mislabeled as excluded from the runtime', async () =>
  temp(async (root) => {
    const f = fixture(),
      installed = await resolveCefRuntime(options(root, f))
    await writeFile(join(installed.directory, 'host.pdb'), 'separate symbols')
    await expect(
      packageCefRuntime({
        directory: installed.directory,
        output: join(root, 'symbols.tar.gz'),
        url: f.manifest.archive.url,
        identity,
        layout: f.manifest.layout,
        notices: f.manifest.notices,
      })
    ).rejects.toThrow('debug symbols')
  }))
test('strict umask does not corrupt signed directory permissions', async () =>
  temp(async (root) => {
    if (process.platform === 'win32') return
    const f = fixture(),
      members = f.manifest.members.map((m) => (m.type === 'directory' ? { ...m, mode: 0o755 } : m))
    const tar = Buffer.concat([
      ...members.flatMap((m) => {
        const parts = [runtimeTarHeader(m)]
        if (m.type === 'file') {
          parts.push(f.files.find((v) => v.path === m.path)!.bytes)
          const pad = (512 - (m.size % 512)) % 512
          if (pad) parts.push(Buffer.alloc(pad))
        }
        return parts
      }),
      Buffer.alloc(1024),
    ])
    const bytes = gzipSync(tar),
      manifest = {
        ...f.manifest,
        members,
        archive: {
          ...f.manifest.archive,
          size: bytes.length,
          sha256: digest(bytes),
          tarBytes: tar.length,
        },
      }
    const o = { ...options(root), envelope: envelope(manifest) }
    const { fetcher: _, ...inputs } = o
    void _
    const module = join(import.meta.dir, '../packages/artifacts/src/cef-cache.ts')
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import {resolveCefRuntime} from ${JSON.stringify(module)};process.umask(0o077);await resolveCefRuntime({...${JSON.stringify(inputs)},fetcher:async()=>new Response(Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'))})`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const diagnostics = await new Response(child.stderr).text()
    expect(await child.exited, diagnostics).toBe(0)
    expect((await lstat(join(root, manifest.archive.sha256, 'resources'))).mode & 0o777).toBe(0o755)
  }))

test('warm shared runtime leases admit another consumer without waiting for the first app to exit', async () =>
  temp(async (root) => {
    const o = options(root)
    const initial = await resolveCefRuntime(o)
    await withCefRuntime(o, async (first) => {
      await withCefRuntime({ ...o, offline: true, timeoutMs: 500 }, async (second) => {
        expect(second).toBe(first)
        expect(second).toBe(initial.directory)
        await expect(removeCefRuntime({ ...o, timeoutMs: 30 })).rejects.toThrow()
      })
      await expect(removeCefRuntime({ ...o, timeoutMs: 30 })).rejects.toThrow()
    })
    await removeCefRuntime(o)
  }))

test('download setup failure cancels and unlocks its acquired response body', async () =>
  temp(async (root) => {
    const f = fixture()
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
      })
    )
    await expect(
      resolveCefRuntime({
        ...options(root, f),
        fetcher: async () => {
          const { readdir } = await import('node:fs/promises')
          const stage = (await readdir(root)).find((name) => name.startsWith('.cef-'))!
          await writeFile(join(root, stage, 'runtime.tar.gz'), 'force exclusive-open failure')
          return response
        },
      })
    ).rejects.toThrow('EEXIST')
    expect(cancelled).toBe(true)
    expect(response.body!.locked).toBe(false)
  }))

test('warm leased reuse still rejects tampering and invalid options, and releases after callback failure', async () =>
  temp(async (root) => {
    const o = options(root)
    const initial = await resolveCefRuntime(o)
    for (const reserveBytes of [-1, NaN, Infinity]) {
      await expect(withCefRuntime({ ...o, reserveBytes }, async () => 'unused')).rejects.toThrow(
        'reserve'
      )
    }
    await expect(
      withCefRuntime(o, async () => {
        throw new Error('consumer failed')
      })
    ).rejects.toThrow('consumer failed')
    await writeFile(join(initial.directory, 'host'), 'evil')
    let called = false
    await expect(
      withCefRuntime({ ...o, offline: true }, async () => {
        called = true
      })
    ).rejects.toThrow('Corrupt runtime')
    expect(called).toBe(false)
    await removeCefRuntime(o)
  }))
