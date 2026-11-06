import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  currentRelease,
  dataDirectory,
  directorySource,
  httpSource,
  install,
  integrationPaths,
  readState,
  recover,
  rollback,
  type PayloadSource,
} from '../../scripts/native/installation.ts'
import {
  createUpdateManifest,
  keyId,
  maximumManifestBytes,
  parseUpdateManifest,
  signUpdate,
  UpdateError,
  verifyBuildManifest,
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
  // A release directory is one name under versions/, never only dots.
  for (const directory of ['versions/.', 'versions/..', 'versions/...', 'versions/a/b'])
    await writeFile(
      join(root, 'state.json'),
      JSON.stringify({ ...state, current: { ...state.current, directory } })
    ).then(() => rejects(rollback(root), 'state'))

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
  },
  60_000
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

function cli(...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, join(repository, 'scripts/release-update.ts'), ...args],
    { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
  )
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

test('release-update CLI creates, signs, installs, reports and rolls back', async () => {
  const work = await temporary()
  const privateKey = join(work, 'private.pem')
  const publicKey = join(work, 'public.pem')
  await writeFile(privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  await writeFile(publicKey, publicPem)
  const root = join(work, 'install')
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
}, 60_000)

test('non-object manifests, oversized or non-JSON bytes and non-Ed25519 keys are rejected', async () => {
  for (const value of [null, [], 'manifest', 1])
    await rejects(() => parseUpdateManifest(value), 'malformed')
  const unsignedPolicy = { kind: 'unsigned-experimental' } as const
  await rejects(
    () => verifyUpdate(new Uint8Array(), undefined, unsignedPolicy, requirements),
    'malformed'
  )
  await rejects(
    () =>
      verifyUpdate(
        new Uint8Array(maximumManifestBytes + 1),
        undefined,
        unsignedPolicy,
        requirements
      ),
    'malformed'
  )
  await rejects(
    () => verifyUpdate(Buffer.from('{not json'), undefined, unsignedPolicy, requirements),
    'malformed'
  )
  await rejects(
    () => verifyUpdate(Buffer.from([0x7b, 0xff, 0x7d]), undefined, unsignedPolicy, requirements),
    'malformed'
  )

  const x25519 = generateKeyPairSync('x25519').publicKey
  await rejects(() => keyId(x25519), 'untrusted')
  expect(keyId(publicPem)).toMatch(/^[0-9a-f]{16}$/)
  expect(keyId(keys.publicKey)).toBe(keyId(publicPem))
  // A configured key of the wrong algorithm fails closed instead of being skipped.
  const update = await release('one', 1)
  await rejects(
    () =>
      verifyUpdate(
        update.bytes,
        update.signature,
        { kind: 'ed25519', publicKeys: [x25519, publicPem] },
        requirements
      ),
    'untrusted'
  )
  // Key objects are accepted alongside PEM text, and the recorded id is the matching key.
  const verified = verifyUpdate(
    update.bytes,
    update.signature,
    { kind: 'ed25519', publicKeys: [generateKeyPairSync('ed25519').publicKey, keys.publicKey] },
    requirements
  )
  expect(verified.trust).toEqual({ kind: 'ed25519', key: keyId(publicPem) })
})

test('a staged build manifest that is not JSON or names another Bun revision fails integrity', async () => {
  const update = await release('one', 1)
  const staged = await temporary()
  await writeFile(join(staged, 'manifest.json'), '{not json')
  await rejects(verifyBuildManifest(staged, update.manifest), 'integrity')
  const build = JSON.parse(await readFile(join(update.payload, 'manifest.json'), 'utf8'))
  build.toolchain.bun.revision = '0'.repeat(40)
  await writeFile(join(staged, 'manifest.json'), JSON.stringify(build))
  const error = await rejects(verifyBuildManifest(staged, update.manifest), 'integrity')
  expect(error.message).toContain('Bun revision')
  expect(error.message).not.toContain('executable')
  await verifyBuildManifest(update.payload, update.manifest)
})

test.skipIf(process.platform === 'win32')(
  'manifest creation refuses a build output that contains a symbolic link',
  async () => {
    const payload = await build('one')
    await symlink('manifest.json', join(payload, 'development/link.json'))
    await expect(
      createUpdateManifest(payload, {
        product: 'dev.bun-native.example',
        version: '1.0.1',
        sequence: 1,
        trust: 'ed25519',
        protocol: requirements.protocol,
      })
    ).rejects.toThrow('Release payloads contain only regular files: development/link.json')
  }
)

test('installation state with an unsupported schema or an unreadable file fails closed', async () => {
  const root = join(await temporary(), 'install')
  const update = await release('one', 1)
  await install(
    root,
    verifyUpdate(update.bytes, update.signature, signed, requirements),
    directorySource(update.payload)
  )
  const text = await readFile(join(root, 'state.json'), 'utf8')
  await writeFile(
    join(root, 'state.json'),
    JSON.stringify({ ...JSON.parse(text), schemaVersion: 2 })
  )
  await rejects(readState(root), 'state')
  await writeFile(join(root, 'state.json'), 'null')
  await rejects(readState(root), 'state')
  // Errors other than a missing file are not mistaken for "nothing is installed".
  await rm(join(root, 'state.json'))
  await mkdir(join(root, 'state.json'))
  const error = await readState(root).catch((caught: unknown) => caught)
  expect(error).not.toBeInstanceOf(UpdateError)
  expect((error as NodeJS.ErrnoException).code).toBe('EISDIR')
  await mkdir(join(root, 'integration.json'))
  const integration = await integrationPaths(root).catch((caught: unknown) => caught)
  expect(integration).not.toBeInstanceOf(UpdateError)
  expect((integration as NodeJS.ErrnoException).code).toBe('EISDIR')
})

test('rollback refuses a retained release with a missing file, and a retained release is not reinstalled', async () => {
  const root = join(await temporary(), 'install')
  const first = await release('one', 1)
  const second = await release('two', 2)
  const verifiedSecond = verifyUpdate(second.bytes, second.signature, signed, requirements)
  await install(
    root,
    verifyUpdate(first.bytes, first.signature, signed, requirements),
    directorySource(first.payload)
  )
  await install(root, verifiedSecond, directorySource(second.payload))
  await rollback(root)
  await installed(root, 'one')
  // After a rollback the newer release is retained as previous: installing it again is refused
  // even though its sequence advances the current one, and rollback rolls it forward instead.
  const error = await rejects(
    install(root, verifiedSecond, directorySource(second.payload)),
    'state'
  )
  expect(error.message).toContain('use rollback')
  await installed(root, 'one')
  const state = (await readState(root))!
  await rm(join(root, state.previous!.directory, 'development/application.js'))
  const missing = await rejects(rollback(root), 'integrity')
  expect(missing.message).toContain('is missing')
  await installed(root, 'one')
  expect(await leftovers(root)).toEqual(clean)
})

test('release-update CLI rejects incomplete commands and never overwrites its outputs', async () => {
  const work = await temporary()
  const help = cli()
  expect(help).toMatchObject({ code: 0, err: '' })
  expect(help.out).toContain('Experimental Bun Native application updates')
  expect(cli('status', 'extra', 'positional')).toMatchObject({ code: 1 })
  expect(cli('status').err).toContain('Experimental Bun Native application updates')
  expect(cli('frobnicate', '--root', work).err).toContain('Unknown command frobnicate')

  const payload = await build('one')
  const manifest = join(work, 'update.json')
  const options = ['--product', 'dev.bun-native.cli', '--version', '1.0.0', '--sequence', '1']
  for (const trust of [[], ['--signed', '--unsigned-experimental']]) {
    const result = cli('manifest', payload, ...options, ...trust, '--out', manifest)
    expect(result).toMatchObject({ code: 1 })
    expect(result.err).toContain('Choose exactly one of --signed or --unsigned-experimental')
  }
  const created = cli('manifest', payload, ...options, '--unsigned-experimental', '--out', manifest)
  expect(created).toMatchObject({ code: 0, err: '' })
  expect(created.out).toContain('Wrote unsigned-experimental update manifest')
  expect(
    cli('manifest', payload, ...options, '--unsigned-experimental', '--out', manifest).err
  ).toContain('EEXIST')
  // Private keys must be named by an absolute path.
  expect(cli('sign', manifest, '--private-key', 'relative.pem')).toMatchObject({ code: 1 })
  expect(existsSync(`${manifest}.sig`)).toBe(false)

  const root = join(work, 'install')
  expect(cli('status', '--root', root).err).toContain('state: Nothing is installed')
  const installedUnsigned = cli(
    'install',
    manifest,
    '--root',
    root,
    '--payload',
    payload,
    '--unsigned-experimental'
  )
  expect(installedUnsigned).toMatchObject({ code: 0, err: '' })
  expect(installedUnsigned.out).toContain('WARNING: installed an UNSIGNED EXPERIMENTAL update')
  expect(JSON.parse(cli('status', '--root', root).out)).toMatchObject({
    version: '1.0.0',
    trust: { kind: 'unsigned-experimental' },
  })
  expect(cli('rollback', '--root', root).err).toContain('No previous release is retained')
  await mkdir(join(root, 'staging/interrupted'))
  expect(JSON.parse(cli('recover', '--root', root).out)).toEqual({
    removed: ['staging/interrupted'],
  })
  expect(cli('integrate', '--root', root, '--name', 'CLI App').err).toContain(
    'Experimental Bun Native application updates'
  )

  const bundles = join(work, 'bundles')
  await mkdir(bundles)
  const bundled = cli('bundle', manifest, '--payload', payload, '--out', bundles)
  expect(bundled).toMatchObject({ code: 0, err: '' })
  expect(bundled.out).toContain('UNSIGNED EXPERIMENTAL bundle')
  expect(await readdir(bundles)).toEqual([
    `dev.bun-native.cli-1.0.0-${process.platform}-${process.arch}`,
  ])
  // An existing bundle directory is never adopted.
  expect(cli('bundle', manifest, '--payload', payload, '--out', bundles).err).toContain('EEXIST')
  expect(JSON.parse(cli('uninstall', '--root', root, '--purge-data').out)).toMatchObject({
    data: 'removed',
  })
  expect(existsSync(root)).toBe(false)
})
