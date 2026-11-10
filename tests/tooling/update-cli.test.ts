import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
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
  expect(JSON.parse(started.stdout.toString())).toMatchObject({
    label: 'one',
    data: join(root, 'data'),
    root,
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
