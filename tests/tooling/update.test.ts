import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  currentRelease,
  dataDirectory,
  directorySource,
  httpSource,
  install,
  readState,
  recover,
  rollback,
  type PayloadSource,
} from '../../scripts/native/installation.ts'
import {
  signUpdate,
  UpdateError,
  verifyUpdate,
  type UpdateManifest,
} from '../../scripts/native/update-manifest.ts'
import {
  build,
  clean,
  cleanup,
  installed,
  keys,
  leftovers,
  publicPem,
  rejects,
  release,
  repository,
  requirements,
  signed,
  temporary,
} from './update-fixture.ts'

afterEach(cleanup)

test('signed update installs atomically, rolls back and preserves user data', async () => {
  const root = join(await temporary(), 'install')
  const first = await release('one', 1)
  await install(
    root,
    verifyUpdate(first.bytes, first.signature, signed, requirements),
    directorySource(first.payload)
  )
  await installed(root, 'one')
  await writeFile(join(dataDirectory(root), 'settings.json'), '{"theme":"dark"}\n')

  const second = await release('two', 2)
  const state = await install(
    root,
    verifyUpdate(second.bytes, second.signature, signed, requirements),
    directorySource(second.payload)
  )
  expect(state.current.trust.kind).toBe('ed25519')
  expect(state.previous?.version).toBe('1.0.1')
  await installed(root, 'two')
  if (process.platform !== 'win32') {
    const { directory, release: current } = await currentRelease(root)
    const executable = Object.keys(current.files).find((path) => path.startsWith('bun-native-host'))
    expect((await stat(join(directory, executable!))).mode & 0o111).toBe(0o111)
  }

  const rolled = await rollback(root)
  expect(rolled.current.version).toBe('1.0.1')
  expect(rolled.previous?.version).toBe('1.0.2')
  await installed(root, 'one')
  expect(await readFile(join(dataDirectory(root), 'settings.json'), 'utf8')).toBe(
    '{"theme":"dark"}\n'
  )
  await rollback(root)
  await installed(root, 'two')

  // A third release evicts only the release that is neither current nor previous.
  const third = await release('three', 3)
  await install(
    root,
    verifyUpdate(third.bytes, third.signature, signed, requirements),
    directorySource(third.payload)
  )
  expect((await readdir(join(root, 'versions'))).length).toBe(2)
  expect(await leftovers(root)).toEqual(clean)
  expect(await readFile(join(dataDirectory(root), 'settings.json'), 'utf8')).toBe(
    '{"theme":"dark"}\n'
  )
})

test('unsigned, tampered and wrongly keyed updates are rejected before download', async () => {
  const update = await release('one', 1)
  await rejects(() => verifyUpdate(update.bytes, undefined, signed, requirements), 'untrusted')
  const tampered = Buffer.from(update.bytes.toString().replace('1.0.1', '1.0.9'))
  await rejects(() => verifyUpdate(tampered, update.signature, signed, requirements), 'untrusted')
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  await rejects(
    () =>
      verifyUpdate(
        update.bytes,
        update.signature,
        { kind: 'ed25519', publicKeys: [other.toString()] },
        requirements
      ),
    'untrusted'
  )
  await rejects(
    () => verifyUpdate(update.bytes, Buffer.from('not a signature'), signed, requirements),
    'untrusted'
  )
  await rejects(
    () =>
      verifyUpdate(
        update.bytes,
        update.signature,
        { kind: 'ed25519', publicKeys: [] },
        requirements
      ),
    'untrusted'
  )
  // A signed manifest cannot be downgraded to unsigned trust by omitting the key.
  await rejects(
    () =>
      verifyUpdate(update.bytes, update.signature, { kind: 'unsigned-experimental' }, requirements),
    'untrusted'
  )
  await rejects(
    () => verifyUpdate(update.bytes, undefined, { kind: 'unsigned-experimental' }, requirements),
    'untrusted'
  )
  // An unsigned manifest validly signed by a trusted key still declares the wrong trust mode.
  const unsigned = await release('two', 2, 'unsigned-experimental')
  await rejects(
    () =>
      verifyUpdate(
        unsigned.bytes,
        Buffer.from(signUpdate(unsigned.bytes, keys.privateKey)),
        signed,
        requirements
      ),
    'untrusted'
  )
})

test('unsigned experimental mode must be chosen explicitly and is recorded', async () => {
  const root = join(await temporary(), 'install')
  const update = await release('one', 1, 'unsigned-experimental')
  const verified = verifyUpdate(
    update.bytes,
    undefined,
    { kind: 'unsigned-experimental' },
    requirements
  )
  const state = await install(root, verified, directorySource(update.payload))
  expect(state.current.trust).toEqual({ kind: 'unsigned-experimental' })
  expect((await readState(root))?.current.trust.kind).toBe('unsigned-experimental')
})

test('incompatible host target, protocol and Bun ABI fail before installation', async () => {
  const update = await release('one', 1)
  for (const change of [
    { os: 'plan9' },
    { architecture: 'mips' },
    { protocol: requirements.protocol + 1 },
    { bunRevision: '0'.repeat(40) },
  ]) {
    const error = await rejects(
      () => verifyUpdate(update.bytes, update.signature, signed, { ...requirements, ...change }),
      'incompatible'
    )
    expect(error.message).toContain('Update requires')
  }
})

test('malformed manifests with unsafe or colliding paths are rejected', async () => {
  const cases: ((manifest: UpdateManifest) => void)[] = [
    (manifest) => {
      manifest.files['../escape'] = { bytes: 1, sha256: 'a'.repeat(64), executable: false }
    },
    (manifest) => {
      manifest.files['Manifest.JSON'] = { bytes: 1, sha256: 'a'.repeat(64), executable: false }
    },
    (manifest) => {
      manifest.files['manifest.json/inner'] = {
        bytes: 1,
        sha256: 'a'.repeat(64),
        executable: false,
      }
    },
    (manifest) => {
      Object.assign(manifest, { channel: 'beta' })
    },
    (manifest) => {
      delete manifest.files['manifest.json']
    },
    (manifest) => {
      manifest.sequence = 0
    },
  ]
  for (const edit of cases) {
    const update = await release('bad', 1, 'ed25519', edit)
    await rejects(
      () => verifyUpdate(update.bytes, update.signature, signed, requirements),
      'malformed'
    )
  }
})

test('partial, oversized and corrupt downloads leave the current release and data intact', async () => {
  const root = join(await temporary(), 'install')
  const first = await release('one', 1)
  await install(
    root,
    verifyUpdate(first.bytes, first.signature, signed, requirements),
    directorySource(first.payload)
  )
  await writeFile(join(dataDirectory(root), 'notes.txt'), 'kept\n')
  const before = await readFile(join(root, 'state.json'), 'utf8')
  const second = await release('two', 2)
  const verified = verifyUpdate(second.bytes, second.signature, signed, requirements)
  const base = directorySource(second.payload)
  const mutate =
    (change: (bytes: Buffer) => Buffer): PayloadSource =>
    async (path) => {
      if (path !== 'manifest.json') return base(path)
      const chunks: Buffer[] = []
      for await (const chunk of await base(path)) chunks.push(Buffer.from(chunk))
      return [change(Buffer.concat(chunks))]
    }
  const failures: PayloadSource[] = [
    mutate((bytes) => bytes.subarray(0, bytes.length - 5)),
    mutate((bytes) => Buffer.concat([bytes, Buffer.from('extra')])),
    mutate((bytes) => {
      const copy = Buffer.from(bytes)
      copy[10] = copy[10]! ^ 1
      return copy
    }),
    async (path) => {
      if (path === 'manifest.json') throw new Error('connection reset')
      return base(path)
    },
  ]
  for (const source of failures) {
    await expect(install(root, verified, source)).rejects.toThrow()
    expect(await readFile(join(root, 'state.json'), 'utf8')).toBe(before)
    expect(await leftovers(root)).toEqual(clean)
    expect((await readdir(join(root, 'versions'))).length).toBe(1)
    await installed(root, 'one')
    expect(await readFile(join(dataDirectory(root), 'notes.txt'), 'utf8')).toBe('kept\n')
  }
  await install(root, verified, base)
  await installed(root, 'two')
})

test('a payload whose build manifest disagrees with the signed inventory is rejected', async () => {
  const root = join(await temporary(), 'install')
  const update = await release('one', 1)
  // Sign an inventory that claims a different host than the build manifest names.
  const mismatched = await release('one', 1, 'ed25519', (manifest) => {
    const host = Object.keys(manifest.files).find((path) => path.startsWith('bun-native-host'))!
    manifest.files[host]!.executable = false
  })
  await rejects(
    install(
      root,
      verifyUpdate(mismatched.bytes, mismatched.signature, signed, requirements),
      directorySource(mismatched.payload)
    ),
    'integrity'
  )
  expect(await readState(root)).toBeNull()
  expect(await leftovers(root)).toEqual(clean)
  await install(
    root,
    verifyUpdate(update.bytes, update.signature, signed, requirements),
    directorySource(update.payload)
  )
})

test('replayed or lower-sequence updates and foreign products are refused', async () => {
  const root = join(await temporary(), 'install')
  const second = await release('two', 2)
  await install(
    root,
    verifyUpdate(second.bytes, second.signature, signed, requirements),
    directorySource(second.payload)
  )
  for (const sequence of [1, 2]) {
    const update = await release('old', sequence)
    await rejects(
      install(
        root,
        verifyUpdate(update.bytes, update.signature, signed, requirements),
        directorySource(update.payload)
      ),
      'downgrade'
    )
  }
  const foreign = await release('foreign', 3, 'ed25519', (manifest) => {
    manifest.product = 'dev.bun-native.other'
  })
  await rejects(
    install(
      root,
      verifyUpdate(foreign.bytes, foreign.signature, signed, requirements),
      directorySource(foreign.payload)
    ),
    'state'
  )
  await installed(root, 'two')
})

test('rollback refuses a modified retained release; corrupt state and live locks fail safely', async () => {
  const root = join(await temporary(), 'install')
  for (const [label, sequence] of [
    ['one', 1],
    ['two', 2],
  ] as const) {
    const update = await release(label, sequence)
    await install(
      root,
      verifyUpdate(update.bytes, update.signature, signed, requirements),
      directorySource(update.payload)
    )
  }
  const state = (await readState(root))!
  await rejects(rollback(join(await temporary(), 'empty')), 'state')
  await writeFile(join(root, state.previous!.directory, 'development/application.js'), 'evil\n')
  await rejects(rollback(root), 'integrity')
  await installed(root, 'two')
  // An empty lock left by a writer that died before recording its process is stale.
  await writeFile(join(root, 'lock'), '')
  expect(await recover(root)).toEqual([])
  expect(existsSync(join(root, 'lock'))).toBe(false)

  await rm(join(root, state.current.directory), { recursive: true })
  await rejects(currentRelease(root), 'integrity')
  await writeFile(join(root, 'state.json'), '{not json')
  await rejects(readState(root), 'state')
  await rejects(currentRelease(join(await temporary(), 'none')), 'state')
  await writeFile(
    join(root, 'state.json'),
    JSON.stringify({ ...state, current: { directory: '../x' } })
  )
  await rejects(rollback(root), 'state')

  await writeFile(join(root, 'lock'), `${process.pid}\n`)
  await rejects(rollback(root), 'busy')
  await rm(join(root, 'lock'))
})

const crashScript = `
import { install, directorySource } from ${JSON.stringify(join(repository, 'scripts/native/installation.ts'))}
import { verifyUpdate } from ${JSON.stringify(join(repository, 'scripts/native/update-manifest.ts'))}
const [root, manifest, payload, phase, requirements] = process.argv.slice(2)
const bytes = await Bun.file(manifest).bytes()
const update = verifyUpdate(bytes, undefined, { kind: 'unsigned-experimental' }, JSON.parse(requirements))
await install(root, update, directorySource(payload), {
  onPhase: (current) => { if (current === phase) process.kill(process.pid, 'SIGKILL') },
})
`

test.skipIf(process.platform === 'win32')(
  'a killed installer at every phase recovers to exactly the old or new release',
  async () => {
    const work = await temporary()
    const script = join(work, 'crash.ts')
    await writeFile(script, crashScript)
    const first = await release('one', 1, 'unsigned-experimental')
    const second = await release('two', 2, 'unsigned-experimental')
    await writeFile(join(work, 'second.json'), second.bytes)
    for (const phase of ['locked', 'downloaded', 'staged', 'promoted', 'committed'] as const) {
      const root = join(work, `install-${phase}`)
      await install(
        root,
        verifyUpdate(first.bytes, undefined, { kind: 'unsigned-experimental' }, requirements),
        directorySource(first.payload)
      )
      await writeFile(join(dataDirectory(root), 'notes.txt'), phase)
      const child = Bun.spawnSync(
        [
          process.execPath,
          script,
          root,
          join(work, 'second.json'),
          second.payload,
          phase,
          JSON.stringify(requirements),
        ],
        { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
      )
      expect(child.signalCode).toBe('SIGKILL')
      expect(existsSync(join(root, 'lock'))).toBe(true)
      await recover(root)
      expect(await leftovers(root)).toEqual(clean)
      await installed(root, phase === 'committed' ? 'two' : 'one')
      expect((await readdir(join(root, 'versions'))).length).toBe(phase === 'committed' ? 2 : 1)
      expect(await readFile(join(dataDirectory(root), 'notes.txt'), 'utf8')).toBe(phase)
      if (phase !== 'committed') {
        await install(
          root,
          verifyUpdate(second.bytes, undefined, { kind: 'unsigned-experimental' }, requirements),
          directorySource(second.payload)
        )
        await installed(root, 'two')
      }
    }
  }
)

test('HTTP payloads require HTTPS except loopback, and truncated responses fail', async () => {
  expect(() => httpSource(new URL('http://example.com/app/'))).toThrow(UpdateError)
  const update = await release('one', 1)
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname.slice(1))
      const file = Bun.file(join(update.payload, path))
      if (path === 'manifest.json' && request.headers.get('x-truncate'))
        return new Response((await file.bytes()).subarray(0, 10))
      return (await file.exists()) ? new Response(file) : new Response('missing', { status: 404 })
    },
  })
  try {
    const root = join(await temporary(), 'install')
    const verified = verifyUpdate(update.bytes, update.signature, signed, requirements)
    const base = new URL(`http://127.0.0.1:${server.port}/`)
    const truncated: PayloadSource = async (path) => {
      const response = await fetch(new URL(path, base), { headers: { 'x-truncate': '1' } })
      return response.body!
    }
    await rejects(install(root, verified, truncated), 'integrity')
    await rejects(install(root, verified, httpSource(new URL('missing/', base))), 'integrity')
    await install(root, verified, httpSource(base))
    await installed(root, 'one')
  } finally {
    await server.stop(true)
  }
})

test('release-update CLI creates, signs, installs, reports and rolls back', async () => {
  const work = await temporary()
  const privateKey = join(work, 'private.pem')
  const publicKey = join(work, 'public.pem')
  await writeFile(privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  await writeFile(publicKey, publicPem)
  const root = join(work, 'install')
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, join(repository, 'scripts/release-update.ts'), ...args],
      { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
    )
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  const payloads: string[] = []
  for (const [label, sequence] of [
    ['one', '1'],
    ['two', '2'],
  ] as const) {
    const payload = await build(label)
    payloads.push(payload)
    const manifest = join(work, `${label}.json`)
    const steps = [
      [
        'manifest',
        payload,
        '--product',
        'dev.bun-native.cli',
        '--version',
        `2.0.${sequence}`,
      ].concat(['--sequence', sequence, '--signed', '--out', manifest]),
      ['sign', manifest, '--private-key', privateKey],
      ['install', manifest, '--root', root, '--payload', payload, '--public-key', publicKey],
    ]
    for (const step of steps) expect(cli(...step)).toMatchObject({ code: 0, err: '' })
  }
  expect(JSON.parse(cli('status', '--root', root).out).version).toBe('2.0.2')
  expect(cli('rollback', '--root', root)).toMatchObject({ code: 0 })
  expect(JSON.parse(cli('status', '--root', root).out).version).toBe('2.0.1')
  const unsigned = cli('install', join(work, 'one.json'), '--root', root, '--payload', work)
  expect(unsigned.code).toBe(1)
  expect(unsigned.err).toContain('exactly one trust mode')

  const bundles = join(work, 'bundles')
  await mkdir(bundles)
  const bundled = cli('bundle', join(work, 'one.json'), '--payload', payloads[0]!, '--out', bundles)
  expect(bundled).toMatchObject({ code: 0, err: '' })
  expect(bundled.out).toContain('signed-manifest bundle')
  const menu = join(work, 'menu')
  const integration = cli('integrate', '--root', root, '--name', 'CLI App', '--applications', menu)
  expect(integration).toMatchObject({ code: 0, err: '' })
  await writeFile(join(dataDirectory(root), 'kept.txt'), 'kept')
  expect(JSON.parse(cli('uninstall', '--root', root).out)).toMatchObject({ data: 'kept' })
  expect(await readdir(root)).toEqual(['data'])
  expect(await readdir(menu)).toEqual([])
})
