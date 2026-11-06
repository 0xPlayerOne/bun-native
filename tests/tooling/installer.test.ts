import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  dataDirectory,
  directorySource,
  install,
  integrationPaths,
  readState,
  recordIntegration,
  recover,
  rollback,
  uninstall,
  type UninstallPhase,
} from '../../scripts/native/installation.ts'
import { createBundle, integrate, launcherScript } from '../../scripts/native/installer.ts'
import {
  createUpdateManifest,
  signUpdate,
  verifyUpdate,
} from '../../scripts/native/update-manifest.ts'
import {
  cleanup,
  installed,
  keys,
  rejects,
  release,
  repository,
  requirements,
  signed,
  temporary,
} from './update-fixture.ts'

afterEach(cleanup)

const posix = process.platform !== 'win32'

async function installTwo(root: string) {
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
}

test('the current pointer follows install and rollback and is repaired by recovery', async () => {
  const root = join(await temporary(), 'install')
  await installTwo(root)
  const pointer = () => readFile(join(root, 'current'), 'utf8')
  const state = (await readState(root))!
  expect(await pointer()).toBe(`${state.current.directory}\n`)
  await rollback(root)
  expect(await pointer()).toBe(`${state.previous!.directory}\n`)
  // A crash between the state and pointer renames leaves the pointer on the retained release.
  await writeFile(join(root, 'current'), `${state.current.directory}\n`)
  await writeFile(join(root, 'current.abc.tmp'), 'partial')
  expect(await recover(root)).toEqual(['current.abc.tmp'])
  expect(await pointer()).toBe(`${state.previous!.directory}\n`)
})

test.skipIf(!posix)(
  'the generated POSIX launcher runs the current release with the data directory',
  async () => {
    const root = join(await temporary(), 'install')
    const update = await release('one', 1, 'ed25519')
    // Replace the synthetic application with a script that reports its environment.
    const script = '#!/bin/sh\necho "$BUN_NATIVE_DATA_DIR|$1"\n'
    await writeFile(join(update.payload, 'application'), script)
    const manifestJson = JSON.parse(await readFile(join(update.payload, 'manifest.json'), 'utf8'))
    manifestJson.application.sha256 = new Bun.CryptoHasher('sha256').update(script).digest('hex')
    await writeFile(join(update.payload, 'manifest.json'), JSON.stringify(manifestJson))
    const manifest = await createUpdateManifest(update.payload, {
      product: 'dev.bun-native.example',
      version: '1.0.1',
      sequence: 1,
      trust: 'ed25519',
      protocol: requirements.protocol,
    })
    const bytes = Buffer.from(JSON.stringify(manifest))
    await install(
      root,
      verifyUpdate(bytes, Buffer.from(signUpdate(bytes, keys.privateKey)), signed, requirements),
      directorySource(update.payload)
    )
    const applications = join(await temporary(), 'applications')
    const [launcher, entry] = await integrate(root, {
      platform: process.platform as 'linux' | 'darwin',
      name: 'Example App',
      applications,
    })
    const run = Bun.spawnSync([launcher!, 'argument with space'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString()).toBe(`${dataDirectory(root)}|argument with space\n`)
    expect(await integrationPaths(root)).toEqual([entry!])
    // A tampered pointer that escapes versions/ is refused by the launcher.
    await writeFile(join(root, 'current'), '../../bin/sh\n')
    expect(Bun.spawnSync([launcher!], { stderr: 'pipe' }).exitCode).toBe(1)
  }
)

test('each launcher refuses a pointer that is not exactly versions/<name>', async () => {
  const root = join(await temporary(), 'install')
  await mkdir(join(root, 'bin'), { recursive: true })
  const launcher = join(root, 'bin', posix ? 'launch' : 'launch.cmd')
  await writeFile(launcher, launcherScript(posix ? 'linux' : 'win32', root), { mode: 0o755 })
  const run = async (pointer: string) => {
    await writeFile(join(root, 'current'), pointer)
    return Bun.spawnSync([launcher], { stdout: 'pipe', stderr: 'pipe' })
  }
  for (const pointer of [
    '',
    '../../bin/sh',
    '/versions/a',
    'versions',
    'versions/',
    'versions/.',
    'versions/..',
    'versions/...',
    'versions/../x',
    'versions/a/b',
    'versions/a b',
    'versions/a;b',
    'versions/a&b',
    'versions/a\\b',
    'versions/a\n../x',
  ])
    expect([pointer, (await run(pointer + '\n')).exitCode]).toEqual([pointer, 1])
  // A well-formed pointer passes validation and fails only at the missing application.
  const missing = await run('versions/1.0.0-dev.1\n')
  expect(missing.exitCode).not.toBe(0)
  expect(missing.exitCode).not.toBe(1)
})

test('platform integrations write a desktop entry, an app wrapper and a Start-menu command', async () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const root = join(await temporary(), 'install')
    await installTwo(root)
    const applications = join(await temporary(), 'menu')
    const [launcher, entry] = await integrate(root, { platform, name: 'Example App', applications })
    const product = 'dev.bun-native.example'
    if (platform === 'linux') {
      expect(entry).toBe(join(applications, `${product}.desktop`))
      const text = await readFile(entry!, 'utf8')
      expect(text).toContain(`Exec="${launcher}" %U`)
      expect(text).toContain('X-Bun-Native-Signing=unsigned-experimental')
    } else if (platform === 'darwin') {
      expect(entry).toBe(join(applications, 'Example App.app'))
      const plist = await readFile(join(entry!, 'Contents/Info.plist'), 'utf8')
      expect(plist).toContain('<string>dev.bun-native.example</string>')
      expect(plist).toContain('<string>1.0.2</string>')
      expect(await readFile(join(entry!, 'Contents/MacOS', product), 'utf8')).toBe(
        launcherScript('darwin', root)
      )
    } else {
      expect(launcher).toBe(join(root, 'bin', `${product}.cmd`))
      expect(await readFile(launcher!, 'utf8')).toContain('set "release=%release:/=\\%"')
      expect(await readFile(entry!, 'utf8')).toBe(`@echo off\r\ncall "${launcher}" %*\r\n`)
    }
  }
  const root = join(await temporary(), 'install')
  await rejects(integrate(root, { platform: 'linux', name: 'X', applications: root }), 'state')
  await installTwo(root)
  await rejects(integrate(root, { platform: 'linux', name: '../x', applications: root }), 'state')
  for (const unsafe of ['a"b', "a'b", 'a$b', 'a`b', 'a%b', 'a!b', 'a&b'])
    await rejects(
      integrate(root, { platform: 'win32', name: 'X', applications: join(root, unsafe) }),
      'state'
    )
  // Windows 8.3 short names, as in %TEMP% = C:\Users\RUNNER~1\AppData\Local\Temp, are valid.
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const short = join(root, 'RUNNER~1', platform)
    const [, entry] = await integrate(root, { platform, name: 'X', applications: short })
    expect(entry!.startsWith(short)).toBe(true)
    expect(existsSync(entry!)).toBe(true)
  }
  await rejects(recordIntegration(join(await temporary(), 'none'), ['/x']), 'state')
})

test('uninstall removes releases and integrations but keeps user data unless purged', async () => {
  const root = join(await temporary(), 'install')
  await installTwo(root)
  const applications = join(await temporary(), 'menu')
  const [, entry] = await integrate(root, { platform: 'linux', name: 'Example App', applications })
  await writeFile(join(dataDirectory(root), 'settings.json'), '{"keep":true}\n')
  expect(await uninstall(root)).toEqual({ removed: [entry!], data: 'kept' })
  expect(existsSync(entry!)).toBe(false)
  expect((await readdir(root)).sort()).toEqual(['data'])
  expect(await readFile(join(dataDirectory(root), 'settings.json'), 'utf8')).toBe('{"keep":true}\n')
  // Reinstalling reuses the preserved data; a purge then removes the whole root.
  await installTwo(root)
  await installed(root, 'two')
  expect(await readFile(join(dataDirectory(root), 'settings.json'), 'utf8')).toBe('{"keep":true}\n')
  expect(await uninstall(root, { purgeData: true })).toEqual({ removed: [], data: 'removed' })
  expect(existsSync(root)).toBe(false)
  await rejects(uninstall(root), 'state')
  await installTwo(root)
  await writeFile(join(root, 'integration.json'), '{"paths":["relative"]}')
  await rejects(integrationPaths(root), 'state')
})

const crashScript = `
import { uninstall } from ${JSON.stringify(join(repository, 'scripts/native/installation.ts'))}
const [root, phase] = process.argv.slice(2)
await uninstall(root, { onPhase: (current) => { if (current === phase) process.kill(process.pid, 'SIGKILL') } })
`

test.skipIf(!posix)(
  'an uninstall killed at every phase completes on rerun or recovery and keeps data',
  async () => {
    const work = await temporary()
    const script = join(work, 'crash.ts')
    await writeFile(script, crashScript)
    for (const phase of ['locked', 'detached', 'committed'] as UninstallPhase[]) {
      const root = join(work, `install-${phase}`)
      await installTwo(root)
      const [, entry] = await integrate(root, {
        platform: 'linux',
        name: 'Example App',
        applications: join(work, `menu-${phase}`),
      })
      await writeFile(join(dataDirectory(root), 'notes.txt'), phase)
      const child = Bun.spawnSync([process.execPath, script, root, phase], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      })
      expect(child.signalCode).toBe('SIGKILL')
      if (phase === 'locked') {
        // Nothing was committed: the app is still installed and usable.
        await recover(root)
        await installed(root, 'two')
        expect(existsSync(entry!)).toBe(true)
      } else if (phase === 'committed') {
        // State is gone, so recovery alone removes the orphaned releases.
        await recover(root)
        expect(await readdir(join(root, 'versions'))).toEqual([])
        expect(existsSync(join(root, 'current'))).toBe(false)
      }
      expect(existsSync(entry!)).toBe(phase === 'locked')
      await uninstall(root)
      expect((await readdir(root)).sort()).toEqual(['data'])
      expect(existsSync(entry!)).toBe(false)
      expect(await readFile(join(dataDirectory(root), 'notes.txt'), 'utf8')).toBe(phase)
    }
  }
)

test('bundles carry the manifest, signature and verified payload, and reject mismatches', async () => {
  const outdir = await temporary()
  const update = await release('one', 1)
  const manifestPath = join(await temporary(), 'update.json')
  await writeFile(manifestPath, update.bytes)
  await writeFile(`${manifestPath}.sig`, update.signature!)
  const bundle = await createBundle(update.payload, manifestPath, outdir)
  expect(bundle.signed).toBe(true)
  expect(bundle.directory).toBe(
    join(outdir, `dev.bun-native.example-1.0.1-${process.platform}-${process.arch}`)
  )
  expect(await readFile(join(bundle.directory, 'update.json'))).toEqual(update.bytes)
  expect(await readFile(join(bundle.directory, 'README.txt'), 'utf8')).toContain(
    'OS code signature is NOT present'
  )
  // The bundle installs exactly like the original build directory.
  const root = join(await temporary(), 'install')
  await install(
    root,
    verifyUpdate(
      await readFile(join(bundle.directory, 'update.json')),
      await readFile(join(bundle.directory, 'update.json.sig')),
      signed,
      requirements
    ),
    directorySource(join(bundle.directory, 'payload'))
  )
  await installed(root, 'one')
  await expect(createBundle(update.payload, manifestPath, outdir)).rejects.toThrow()

  const unsigned = await release('two', 2, 'unsigned-experimental')
  const unsignedPath = join(await temporary(), 'update.json')
  await writeFile(unsignedPath, unsigned.bytes)
  const plain = await createBundle(unsigned.payload, unsignedPath, await temporary())
  expect(plain.signed).toBe(false)
  expect(await readFile(join(plain.directory, 'README.txt'), 'utf8')).toContain(
    'UNSIGNED EXPERIMENTAL'
  )
  await writeFile(`${unsignedPath}.sig`, update.signature!)
  await rejects(createBundle(unsigned.payload, unsignedPath, await temporary()), 'untrusted')
  await rm(`${unsignedPath}.sig`)
  await writeFile(join(unsigned.payload, 'manifest.json'), '{}')
  await rejects(createBundle(unsigned.payload, unsignedPath, await temporary()), 'integrity')
})
