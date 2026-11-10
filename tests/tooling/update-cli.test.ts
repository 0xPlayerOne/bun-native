import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import toolchain from '../../toolchain.json'
import { fileDigest } from '../../scripts/native/artifact.ts'
import { cleanup, repository, temporary } from './update-fixture.ts'

afterEach(cleanup)

const windows = process.platform === 'win32'
const suffix = windows ? '.exe' : ''

function cli(...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, join(repository, 'scripts/release-update.ts'), ...args],
    { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 }
  )
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

function ok(...args: string[]) {
  const result = cli(...args)
  expect({ args, ...result }).toMatchObject({ code: 0, err: '' })
  return result.out
}

/**
 * A build output whose application is a real executable: a copy of the running Bun, so
 * the same test runs on every platform. `label.txt` tells releases apart.
 */
async function executableBuild(label: string): Promise<string> {
  const directory = await temporary()
  const application = join(directory, `application${suffix}`)
  await copyFile(process.execPath, application)
  await writeFile(join(directory, `bun-native-host${suffix}`), `host ${label}\n`)
  await writeFile(join(directory, 'label.txt'), label)
  const manifest = {
    schemaVersion: 1,
    target: { os: process.platform, architecture: process.arch },
    toolchain: { bun: { revision: toolchain.bun.revision } },
    application: { file: `application${suffix}`, ...(await fileDigest(application)) },
    host: {
      file: `bun-native-host${suffix}`,
      ...(await fileDigest(join(directory, `bun-native-host${suffix}`))),
    },
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return directory
}

// The application prints what the launcher gave it and exits with the requested code.
const report = [
  '-e',
  `const { dirname, join } = require('node:path');
   console.log(JSON.stringify({
     label: require('node:fs').readFileSync(join(dirname(process.execPath), 'label.txt'), 'utf8'),
     data: process.env.BUN_NATIVE_DATA_DIR,
     root: process.env.BUN_NATIVE_INSTALL_ROOT,
     release: process.env.BUN_NATIVE_RELEASE,
     argument: process.argv.at(-1),
   }));
   process.exitCode = Number(process.argv.at(-1)) || 0`,
]

// The application reports a passed health check through @bun-native/core.
const reportHealth = [
  '-e',
  `const core = require(${JSON.stringify(join(repository, 'packages/runtime/src/installation.ts'))});
   const pending = core.installedRelease().healthPending;
   core.reportHealthy().then((reported) => console.log(JSON.stringify({ pending, reported })))`,
]

test('keyed signing, rotation, health-checked install and verified launch through the CLI', async () => {
  const work = await temporary()
  const root = join(work, 'install')
  const key = (name: string) => [join(work, `${name}.pem`), join(work, `${name}.pub.pem`)] as const
  const [firstPrivate, firstPublic] = key('first')
  const [secondPrivate, secondPublic] = key('second')
  const first = JSON.parse(
    ok('keygen', '--private-key', firstPrivate, '--public-key', firstPublic)
  ) as { key: string }
  ok('keygen', '--private-key', secondPrivate, '--public-key', secondPublic)
  if (!windows) expect((await Bun.file(firstPrivate).stat()).mode & 0o777).toBe(0o600)
  expect(
    cli('keygen', '--private-key', firstPrivate, '--public-key', join(work, 'x.pem')).err
  ).toContain('already exists')
  expect(existsSync(join(work, 'x.pem'))).toBe(false)

  const keysV1 = join(work, 'keys-1.json')
  expect(
    cli('key-set', '--product', 'dev.bun-native.cli', '--version', '1', '--public-key', firstPublic)
      .code
  ).toBe(1)
  ok(
    'key-set',
    '--product',
    'dev.bun-native.cli',
    '--version',
    '1',
    '--minimum-sequence',
    '1',
    '--public-key',
    firstPublic,
    '--out',
    keysV1
  )
  // Version 2 adds the second key; a key the current set trusts signs it.
  const keysV2 = join(work, 'keys-2.json')
  ok(
    'key-set',
    '--product',
    'dev.bun-native.cli',
    '--version',
    '2',
    '--minimum-sequence',
    '1',
    '--public-key',
    firstPublic,
    '--public-key',
    secondPublic,
    '--out',
    keysV2
  )
  ok('sign', keysV2, '--private-key', firstPrivate, '--keyed')
  expect((await readFile(`${keysV2}.sig`, 'utf8')).startsWith(`${first.key} `)).toBe(true)

  const publish = async (label: string, sequence: number, signer: string) => {
    const payload = await executableBuild(label)
    const manifest = join(work, `${label}.json`)
    ok(
      'manifest',
      payload,
      '--product',
      'dev.bun-native.cli',
      '--version',
      `3.0.${sequence}`,
      '--sequence',
      String(sequence),
      '--signed',
      '--out',
      manifest
    )
    ok('sign', manifest, '--private-key', signer, '--keyed')
    return { payload, manifest }
  }
  const one = await publish('one', 1, firstPrivate)
  ok('install', one.manifest, '--root', root, '--payload', one.payload, '--key-set', keysV1)
  // A manifest signed by the second key is refused until the rotation is shipped with it.
  const two = await publish('two', 2, secondPrivate)
  const install = ['install', two.manifest, '--root', root, '--payload', two.payload]
  expect(cli(...install, '--key-set', keysV1).err).toContain('is not a trusted key')
  const installed = JSON.parse(
    ok(...install, '--key-set', keysV1, '--rotation', keysV2, '--health-limit', '1')
  ) as { health: unknown }
  expect(installed.health).toEqual({ status: 'pending', attempts: 0, limit: 1 })
  expect(JSON.parse(await readFile(join(root, 'keys.json'), 'utf8')).version).toBe(2)

  // The CLI launch verifies, counts the start attempt and passes the environment through.
  const status = JSON.parse(ok('status', '--root', root)) as { release: string; version: string }
  expect(status.version).toBe('3.0.2')
  const launched = cli('launch', '--root', root, '--key-set', keysV1, '--', ...report, '7')
  expect(launched.code).toBe(7)
  expect(JSON.parse(launched.out)).toEqual({
    label: 'two',
    data: join(root, 'data'),
    root,
    release: status.release,
    argument: '7',
  })
  // The only allowed start went unconfirmed, so the next launch rolls back to release one.
  const fallback = cli('launch', '--root', root, '--', ...report, '0')
  expect(fallback.code).toBe(0)
  expect(fallback.err).toContain('Rolled back release 3.0.2 (unconfirmed)')
  expect(JSON.parse(fallback.out).label).toBe('one')
  // Version 3 revokes the first key, which signed release one: starting it is now refused.
  const keysV3 = join(work, 'keys-3.json')
  ok(
    'key-set',
    '--product',
    'dev.bun-native.cli',
    '--version',
    '3',
    '--minimum-sequence',
    '1',
    '--public-key',
    secondPublic,
    '--revoke',
    first.key,
    '--out',
    keysV3
  )
  ok('sign', keysV3, '--private-key', secondPrivate, '--keyed')
  ok('rotate', keysV3, '--root', root, '--key-set', keysV1)
  const revoked = cli('launch', '--root', root, '--', ...report)
  expect(revoked).toMatchObject({ code: 1, out: '' })
  expect(revoked.err).toContain(`signed by revoked key ${first.key}`)
  // The failed sequence cannot be installed again.
  expect(cli(...install, '--key-set', keysV3).err).toContain('does not advance failed release 2')

  const three = await publish('three', 3, secondPrivate)
  ok(
    'install',
    three.manifest,
    '--root',
    root,
    '--payload',
    three.payload,
    '--key-set',
    keysV3,
    '--health-limit',
    '2'
  )
  const current = JSON.parse(ok('status', '--root', root)) as { release: string }
  expect(cli('confirm', '--root', root, '--release', 'f'.repeat(64)).err).toContain(
    'is not the current release'
  )
  // The application reports its own health; the launcher confirms the pending release.
  const healthy = cli('launch', '--root', root, '--', ...reportHealth)
  expect(healthy).toMatchObject({ code: 0, err: '' })
  expect(JSON.parse(healthy.out)).toEqual({ pending: true, reported: true })
  expect(await readdir(join(root, 'health'))).toEqual([])
  const again = cli('launch', '--root', root, '--', ...reportHealth)
  expect(JSON.parse(again.out)).toEqual({ pending: false, reported: false })
  ok('confirm', '--root', root, '--release', current.release)
  expect(
    cli('report-unhealthy', '--root', root, '--release', current.release, '--key-set', keysV3).err
  ).toContain('already confirmed healthy')
  expect(cli('status', '--root', root, '--', 'x')).toMatchObject({ code: 1 })
}, 120_000)

test('the compiled verifying launcher starts the current release and refuses a modified one', async () => {
  const work = await temporary()
  const root = join(work, 'install')
  const launcher = join(work, `launcher${suffix}`)
  ok('launcher', '--out', launcher)
  expect(cli('launcher', '--out', launcher).err).toContain('already exists')
  const payload = await executableBuild('one')
  const manifest = join(work, 'one.json')
  ok(
    'manifest',
    payload,
    '--product',
    'dev.bun-native.cli',
    '--version',
    '1.0.0',
    '--sequence',
    '1',
    '--unsigned-experimental',
    '--out',
    manifest
  )
  ok('install', manifest, '--root', root, '--payload', payload, '--unsigned-experimental')
  const menu = join(work, 'menu')
  const created = JSON.parse(
    ok(
      'integrate',
      '--root',
      root,
      '--name',
      'CLI App',
      '--applications',
      menu,
      '--verified-launcher',
      launcher
    )
  ) as { created: string[] }
  const installedLauncher = created.created[0]!
  expect(installedLauncher).toBe(join(root, 'bin', `dev.bun-native.cli${suffix}`))
  const run = () =>
    Bun.spawnSync([installedLauncher, ...report, '5'], { stdout: 'pipe', stderr: 'pipe' })
  const started = run()
  expect(started.exitCode).toBe(5)
  // The launcher finds the root from its resolved executable path (/private/var on macOS).
  const resolvedRoot = await realpath(root)
  expect(JSON.parse(started.stdout.toString())).toMatchObject({
    label: 'one',
    data: join(resolvedRoot, 'data'),
    root: resolvedRoot,
  })
  if (process.platform === 'darwin') {
    const wrapper = join(menu, 'CLI App.app', 'Contents', 'MacOS', 'dev.bun-native.cli')
    expect(await readFile(wrapper, 'utf8')).toContain(installedLauncher)
  }
  // Unlike the pointer script, the verified launcher re-hashes the release on every start.
  const [release] = await readdir(join(root, 'versions'))
  await writeFile(join(root, 'versions', release!, 'label.txt'), 'tampered')
  const refused = run()
  expect(refused.exitCode).toBe(1)
  expect(refused.stderr.toString()).toContain('label.txt')
}, 120_000)

test('a self-contained bundle installs, integrates and starts without Bun or the repository', async () => {
  const work = await temporary()
  const [privateKey, publicKey] = [join(work, 'key.pem'), join(work, 'key.pub.pem')]
  ok('keygen', '--private-key', privateKey, '--public-key', publicKey)
  const keySet = join(work, 'keys.json')
  ok(
    'key-set',
    '--product',
    'dev.bun-native.cli',
    '--version',
    '1',
    '--public-key',
    publicKey,
    '--out',
    keySet
  )
  const payload = await executableBuild('bundled')
  const manifest = join(work, 'update.json')
  ok(
    'manifest',
    payload,
    '--product',
    'dev.bun-native.cli',
    '--version',
    '1.0.0',
    '--sequence',
    '1',
    '--signed',
    '--out',
    manifest
  )
  ok('sign', manifest, '--private-key', privateKey, '--keyed')
  const bundles = join(work, 'bundles')
  await mkdir(bundles)
  expect(
    cli('bundle', manifest, '--payload', payload, '--out', bundles, '--key-set', keySet).err
  ).toContain('--self-contained')
  ok(
    'bundle',
    manifest,
    '--payload',
    payload,
    '--out',
    bundles,
    '--self-contained',
    '--key-set',
    keySet
  )
  const [name] = await readdir(bundles)
  const bundle = join(bundles, name!)
  expect((await readdir(bundle)).sort()).toEqual(
    [
      'README.txt',
      `bun-native-update${suffix}`,
      'keys.json',
      `launcher${suffix}`,
      'payload',
      'update.json',
      'update.json.sig',
    ].sort()
  )
  expect(await readFile(join(bundle, 'README.txt'), 'utf8')).toContain('--key-set keys.json')

  // Run from inside the bundle with no Bun on PATH, as on a clean machine.
  const root = join(work, 'install')
  const tool = join(bundle, `bun-native-update${suffix}`)
  const env = windows
    ? { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows' }
    : { PATH: '/usr/bin:/bin' }
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([tool, ...args], {
      cwd: bundle,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect({ args, code: result.exitCode, err: result.stderr.toString() }).toMatchObject({
      code: 0,
      err: '',
    })
    return result.stdout.toString()
  }
  run('install', 'update.json', '--payload', 'payload', '--root', root, '--key-set', 'keys.json')
  const menu = join(work, 'menu')
  const created = JSON.parse(
    run(
      'integrate',
      '--root',
      root,
      '--name',
      'Bundled App',
      '--applications',
      menu,
      '--verified-launcher',
      `launcher${suffix}`
    )
  ) as { created: string[] }
  const started = Bun.spawnSync([created.created[0]!, ...report, '3'], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(started.exitCode).toBe(3)
  expect(JSON.parse(started.stdout.toString()).label).toBe('bundled')
  const compiled = Bun.spawnSync([tool, 'launcher', '--out', join(work, 'refused')], {
    env,
    stderr: 'pipe',
  })
  expect(compiled.exitCode).toBe(1)
  expect(compiled.stderr.toString()).toContain('needs the Bun Native repository')
}, 180_000)

/** Release 1.0.1 confirmed, then 1.0.2 installed awaiting its health check. */
async function installPending(work: string): Promise<string> {
  const root = join(work, 'install')
  for (const [label, sequence, health] of [
    ['first', '1', []],
    ['second', '2', ['--health-limit', '3']],
  ] as const) {
    const payload = await executableBuild(label)
    const manifest = join(work, `${label}.json`)
    ok(
      'manifest',
      payload,
      '--product',
      'dev.bun-native.cli',
      '--version',
      `1.0.${sequence}`,
      '--sequence',
      sequence,
      '--unsigned-experimental',
      '--out',
      manifest
    )
    ok(
      'install',
      manifest,
      '--root',
      root,
      '--payload',
      payload,
      '--unsigned-experimental',
      ...health
    )
  }
  return root
}

test('a concurrent start of the same pending release cannot erase another launch report', async () => {
  const work = await temporary()
  const root = await installPending(work)
  // Launch A reports health at once, then keeps running until the test lets it exit.
  const go = join(work, 'go')
  const reportThenWait = [
    '-e',
    `const core = require(${JSON.stringify(join(repository, 'packages/runtime/src/installation.ts'))});
     const { existsSync } = require('node:fs');
     core.reportHealthy().then(() => {
       const wait = setInterval(() => { if (existsSync(${JSON.stringify(go)})) clearInterval(wait) }, 20);
     })`,
  ]
  const first = Bun.spawn(
    [
      process.execPath,
      join(repository, 'scripts/release-update.ts'),
      'launch',
      '--root',
      root,
      '--',
      ...reportThenWait,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const mailbox = join(root, 'health')
  const reported = async () => {
    for (const name of existsSync(mailbox) ? await readdir(mailbox) : [])
      if ((await readFile(join(mailbox, name), 'utf8')).length) return name
    return undefined
  }
  const deadline = Date.now() + 30_000
  while (!(await reported()) && first.exitCode === null && Date.now() < deadline) await Bun.sleep(5)
  // Launch B of the same pending release starts and exits without reporting.
  const second = cli('launch', '--root', root, '--', ...report, '0')
  expect(second).toMatchObject({ code: 0, err: '' })
  expect(JSON.parse(second.out).label).toBe('second')
  await writeFile(go, '')
  expect(await first.exited).toBe(0)
  expect(await new Response(first.stderr).text()).toBe('')
  // A's report confirmed the release, and no launch left a mailbox behind.
  const after = cli('launch', '--root', root, '--', ...reportHealth)
  expect(JSON.parse(after.out)).toEqual({ pending: false, reported: false })
  expect(await readdir(mailbox)).toEqual([])
}, 120_000)

test('a report survives a busy installation lock while running and after exit', async () => {
  const runtime = JSON.stringify(join(repository, 'packages/runtime/src/installation.ts'))
  const launchWith = (root: string, script: string) =>
    Bun.spawn(
      [
        process.execPath,
        join(repository, 'scripts/release-update.ts'),
        'launch',
        '--root',
        root,
        '--',
        '-e',
        script,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
  const pending = async (root: string) =>
    JSON.parse(cli('launch', '--root', root, '--', ...reportHealth).out) as {
      pending: boolean
      reported: boolean
    }

  // While running: the app holds the lock as a live process across several polls, then frees it.
  const running = await installPending(await temporary())
  const lock = JSON.stringify(join(running, 'lock'))
  const whileRunning = launchWith(
    running,
    `const { writeFileSync, rmSync } = require('node:fs');
     writeFileSync(${lock}, process.pid + '\\n');
     require(${runtime}).reportHealthy().then(async () => {
       await Bun.sleep(700);
       rmSync(${lock});
       await Bun.sleep(700);
     })`
  )
  expect(await whileRunning.exited).toBe(0)
  expect(await new Response(whileRunning.stderr).text()).toBe('')
  expect(await pending(running)).toEqual({ pending: false, reported: false })

  // After exit: a live process (this test) holds the lock when the app has already exited.
  const exited = await installPending(await temporary())
  const exitedLock = join(exited, 'lock')
  const afterExit = launchWith(
    exited,
    `const { writeFileSync } = require('node:fs');
     writeFileSync(${JSON.stringify(exitedLock)}, ${process.pid} + '\\n');
     require(${runtime}).reportHealthy()`
  )
  const deadline = Date.now() + 30_000
  while (!existsSync(exitedLock) && Date.now() < deadline) await Bun.sleep(5)
  await Bun.sleep(700)
  expect(afterExit.exitCode).toBeNull()
  await rm(exitedLock)
  expect(await afterExit.exited).toBe(0)
  expect(await new Response(afterExit.stderr).text()).toBe('')
  expect(await pending(exited)).toEqual({ pending: false, reported: false })
}, 120_000)
