/** Explicit contributor-only reproducible reference installs. Never publishes or changes a global toolchain. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import {
  referenceInstallation,
  REFERENCE_PACKAGES,
} from '../benchmarks/adapters/references/packages.ts'
const root = resolve(import.meta.dir, '..')
const [name, destination] = process.argv.slice(2)
if ((name !== 'mirin' && name !== 'butter') || !destination)
  throw new Error(
    'Usage: bun scripts/bootstrap-reference-baselines.ts mirin|butter <new-private-directory>'
  )
if (Bun.version !== '1.4.4') throw new Error('Use the pinned Bun 1.4.4 executable')
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This pinned reference preparation targets macOS arm64')
const project = resolve(destination)
await mkdir(project, { mode: 0o700 })
await mkdir(join(project, 'home'))
await mkdir(join(project, 'commands'))
const observations: unknown[] = []
const environment = {
  HOME: join(project, 'home'),
  BUN_INSTALL_CACHE_DIR: join(project, 'home/cache'),
  PATH: dirname(process.execPath) + ':' + (process.env['PATH'] ?? ''),
}
async function run(args: string[], cwd = project) {
  const result = await observedCommand(args, {
    cwd,
    output: join(project, 'commands', `${observations.length}.json`),
    env: environment,
    timeoutMs: 240000,
  }).result
  observations.push(result)
  assertCleanCommand(result)
  return result
}
try {
  const manifest = JSON.parse(
    await readFile(join(root, `benchmarks/adapters/references/${name}.package.json`), 'utf8')
  )
  if (name === 'butter') {
    const source = join(project, 'source')
    await run([
      'git',
      'clone',
      '--no-checkout',
      '--filter=blob:none',
      'https://github.com/wess/butter.git',
      source,
    ])
    await run(['git', 'checkout', '--detach', REFERENCE_PACKAGES.butter.sourceCommit], source)
    const head = await run(['git', 'rev-parse', 'HEAD'], source)
    assert.equal(head.stdoutTail.at(-1), REFERENCE_PACKAGES.butter.sourceCommit)
    const status = await run(['git', 'status', '--porcelain'], source)
    assert.equal(status.stdoutTail.length, 0)
    await run(
      [
        process.execPath,
        'pm',
        'pack',
        '--ignore-scripts',
        '--filename',
        join(project, 'butterframework-1.6.3.tgz'),
      ],
      source
    )
    const bytes = await readFile(join(project, 'butterframework-1.6.3.tgz'))
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      'e9c3aa991391867647348c7b2220cc3143ee664591980591aba798b0c9bdaafa',
      'Source package differs from the reviewed frozen-lock artifact; do not silently replace its pin'
    )
    manifest.dependencies.butterframework = 'file:butterframework-1.6.3.tgz'
  }
  await writeFile(join(project, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await copyFile(
    join(
      root,
      `benchmarks/adapters/references/locks/${name === 'mirin' ? 'mirin' : 'butter-source'}.bun.lock`
    ),
    join(project, 'bun.lock')
  )
  await run([
    process.execPath,
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--linker=hoisted',
    '--backend=copyfile',
  ])
  const lockSha256 = createHash('sha256')
    .update(await readFile(join(project, 'bun.lock')))
    .digest('hex')
  const installation = await referenceInstallation(name, project, lockSha256)
  if (name === 'butter') {
    if (process.platform !== 'darwin')
      throw new Error('The helper-primed source profile is currently qualified for macOS only')
    await run([
      process.execPath,
      join(installation.nodeModules, 'butterframework/src/ipc/shmem/darwin.ts'),
    ])
  }
  await writeFile(
    join(project, 'installation.json'),
    JSON.stringify(
      {
        schema: 1,
        name,
        passed: true,
        sourceProfile: name === 'butter' ? 'git-packed-helper-primed' : 'registry',
        installation,
        observations,
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  )
  console.log(JSON.stringify({ name, passed: true, project, lockSha256 }))
} catch (error) {
  await writeFile(
    join(project, 'installation.json'),
    JSON.stringify(
      { schema: 1, name, passed: false, error: String(error), observations },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  )
  throw error
}
