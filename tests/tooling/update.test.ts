import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import toolchain from '../../toolchain.json'
import { PROTOCOL_VERSION } from '../../packages/protocol/src/index.ts'
import { fileDigest } from '../../scripts/native/artifact.ts'
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
  createUpdateManifest,
  signUpdate,
  UpdateError,
  verifyUpdate,
  type HostRequirements,
  type TrustPolicy,
  type UpdateManifest,
} from '../../scripts/native/update-manifest.ts'

const repository = resolve(import.meta.dir, '../..')
const requirements: HostRequirements = {
  os: process.platform,
  architecture: process.arch,
  protocol: PROTOCOL_VERSION,
  bunRevision: toolchain.bun.revision,
}
const keys = generateKeyPairSync('ed25519')
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const signed: TrustPolicy = { kind: 'ed25519', publicKeys: [publicPem] }
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-update-'))
  directories.push(directory)
  return directory
}

/** A synthetic `native build` output with the fields the updater cross-checks. */
async function build(label: string): Promise<string> {
  const directory = await temporary()
  const suffix = process.platform === 'win32' ? '.exe' : ''
  await writeFile(join(directory, `application${suffix}`), `application ${label}\n`)
  await writeFile(join(directory, `bun-native-host${suffix}`), `host ${label}\n`)
  await mkdir(join(directory, 'development'))
  await writeFile(join(directory, 'development/application.js'), `console.log(${label})\n`)
  const manifest = {
    schemaVersion: 1,
    target: { os: process.platform, architecture: process.arch },
    toolchain: { bun: { revision: toolchain.bun.revision } },
    application: {
      file: `application${suffix}`,
      ...(await fileDigest(join(directory, `application${suffix}`))),
    },
    host: {
      file: `bun-native-host${suffix}`,
      ...(await fileDigest(join(directory, `bun-native-host${suffix}`))),
    },
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return directory
}

async function release(
  label: string,
  sequence: number,
  trust: UpdateManifest['trust'] = 'ed25519',
  edit?: (manifest: UpdateManifest) => void
) {
  const payload = await build(label)
  const manifest = await createUpdateManifest(payload, {
    product: 'dev.bun-native.example',
    version: `1.0.${sequence}`,
    sequence,
    trust,
    protocol: requirements.protocol,
  })
  edit?.(manifest)
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  const signature =
    trust === 'ed25519' ? Buffer.from(signUpdate(bytes, keys.privateKey)) : undefined
  return { payload, manifest, bytes, signature }
}

async function rejects(promise: Promise<unknown> | (() => unknown), code: UpdateError['code']) {
  let error: unknown
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(UpdateError)
  expect((error as UpdateError).code).toBe(code)
  return error as UpdateError
}

async function installed(root: string, label: string) {
  const { directory } = await currentRelease(root)
  const application = (await readdir(directory)).find((name) => name.startsWith('application'))!
  expect(await readFile(join(directory, application), 'utf8')).toBe(`application ${label}\n`)
}

async function leftovers(root: string) {
  return {
    staging: await readdir(join(root, 'staging')),
    lock: existsSync(join(root, 'lock')),
    temporary: (await readdir(root)).filter((name) => name.endsWith('.tmp')),
  }
}

const clean = { staging: [], lock: false, temporary: [] }

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

test('rollback refuses a modified retained release and a live lock blocks writers', async () => {
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
  for (const [label, sequence] of [
    ['one', '1'],
    ['two', '2'],
  ] as const) {
    const payload = await build(label)
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
})
