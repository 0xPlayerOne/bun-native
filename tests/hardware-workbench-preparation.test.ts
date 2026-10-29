import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import {
  parseWorkbenchArguments,
  validateWorkbenchRuntime,
  validateWorkbenchInput,
  prepareHardwareWorkbench,
  inspectPreparedWorkbench,
  runHardwareWorkbench,
} from '../scripts/hardware-workbench.ts'

const root = resolve(import.meta.dir, '..')
const runtime = { schema: 1, protocol: 1, bun_version: '1.4.4', cef_version: '156.0.7' }
const target = `${process.platform}-${process.arch}` as 'linux-x64' | 'darwin-arm64' | 'win32-x64'
const commitPattern = 'a'.repeat(40)

test('native workbench preparation has no launch flag and run requires an exact separate opt-in', () => {
  const path = resolve('prepared app')
  assert.deepEqual(parseWorkbenchArguments(['prepare', path, `--native-source=${commitPattern}`]), {
    mode: 'prepare',
    app: path,
    nativeSource: commitPattern,
  })
  assert.deepEqual(parseWorkbenchArguments(['run', path]), {
    mode: 'run',
    record: path,
    launch: false,
  })
  assert.deepEqual(parseWorkbenchArguments(['run', path, '--launch']), {
    mode: 'run',
    record: path,
    launch: true,
  })
  for (const args of [
    [],
    ['prepare', path],
    ['prepare', path, '--native-source=main'],
    ['prepare', path, `--native-source=${commitPattern}`, '--launch'],
    ['prepare', 'relative', `--native-source=${commitPattern}`],
    ['run', 'relative'],
    ['run', path, '--launch=true'],
    ['run', path, '--no-sandbox'],
    ['run', path, '--launch', '--launch'],
    ['prepare', path, `--native-source=${commitPattern}`, '--fetch'],
  ])
    assert.throws(() => parseWorkbenchArguments(args))
})

test('preparation rejects widened deadlines, credentials, development origins and mismatched runtimes', () => {
  validateWorkbenchRuntime(runtime)
  validateWorkbenchRuntime({
    ...runtime,
    qualification_profile: 'standard',
    maintenance_protocol: 1,
  })
  for (const value of [
    null,
    [],
    {},
    { ...runtime, schema: 2 },
    { ...runtime, protocol: '1' },
    { ...runtime, bun_version: '1.4.5' },
    { ...runtime, cef_version: 'other' },
    { ...runtime, development_origin: 'http://127.0.0.1:8000' },
    { ...runtime, credential_policy: null },
    { ...runtime, qualification_profile: 'emulated-functional' },
    { ...runtime, qualification_profile: 'unbounded' },
    { ...runtime, extra: true },
  ])
    assert.throws(() => validateWorkbenchRuntime(value))
})

async function fakePrebuilt(directory: string, requestedTarget = target) {
  const mac = requestedTarget === 'darwin-arm64'
  const app = join(directory, mac ? 'Input.app' : 'Input')
  const resources = join(app, mac ? 'Contents/Resources' : 'resources')
  const host = join(
    app,
    mac
      ? 'Contents/MacOS/bunly_host'
      : requestedTarget === 'win32-x64'
        ? 'bunly_host.exe'
        : 'bunly_host'
  )
  const bun = join(resources, requestedTarget === 'win32-x64' ? 'bun.exe' : 'bun')
  const library = join(
    app,
    mac
      ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
      : requestedTarget === 'win32-x64'
        ? 'libcef.dll'
        : 'libcef.so'
  )
  for (const directory of [resources, dirname(host), dirname(library)])
    await mkdir(directory, { recursive: true })
  await writeFile(host, 'This is deliberately not an executable native host.\n', { mode: 0o700 })
  await writeFile(bun, 'This is deliberately not an executable Bun runtime.\n', { mode: 0o700 })
  await writeFile(library, 'Not a loadable native library.\n')
  await writeFile(join(resources, 'runtime.json'), JSON.stringify(runtime))
  return { app, resources, host, selection: mac ? app : host }
}

test('prebuilt validation reads fixed app layouts and refuses linked resources or escaping framework links', async () => {
  const work = await mkdtemp(join(tmpdir(), 'bunly-hardware-input-'))
  try {
    const selected = await fakePrebuilt(work)
    assert.deepEqual(
      (await validateWorkbenchInput(selected.selection, target)).artifact,
      await inventory(selected.app)
    )
    await assert.rejects(validateWorkbenchInput(join(work, 'missing'), target))
    await writeFile(
      join(selected.resources, 'runtime.json'),
      JSON.stringify({ ...runtime, development_origin: 'https://example.invalid' })
    )
    await assert.rejects(validateWorkbenchInput(selected.selection, target))
    await writeFile(join(selected.resources, 'runtime.json'), JSON.stringify(runtime))
    if (process.platform !== 'win32') {
      const outside = join(work, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'fixture.txt'), 'preserved')
      await symlink('../outside/fixture.txt', join(selected.app, 'escape'))
      await assert.rejects(validateWorkbenchInput(selected.selection, target), /escapes/)
      await rm(join(selected.app, 'escape'))
      await symlink('runtime.json', join(selected.resources, 'linked'))
      await assert.rejects(
        validateWorkbenchInput(selected.selection, target),
        /must not contain links/
      )
      assert.equal(await readFile(join(outside, 'fixture.txt'), 'utf8'), 'preserved')
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

async function sourceFixture(work: string) {
  const source = join(work, 'source')
  await mkdir(source)
  for (const path of [
    'packages/contracts',
    'packages/client',
    'packages/runtime',
    'examples/hardware-workbench',
  ]) {
    await mkdir(dirname(join(source, path)), { recursive: true })
    await cp(join(root, path), join(source, path), {
      recursive: true,
      filter: (path) => !path.split(/[\\/]/).includes('dist'),
    })
  }
  await mkdir(join(source, 'scripts'))
  for (const name of ['cef-bootstrap.ts', 'hardware-workbench.ts'])
    await cp(join(root, 'scripts', name), join(source, 'scripts', name))
  await writeFile(join(source, '.gitignore'), '.bunly/\n')
  await mkdir(join(source, 'native/cef-host'), { recursive: true })
  await writeFile(
    join(source, 'native/cef-host/source.txt'),
    'Declared native source fixture; never compiled.\n'
  )
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: source,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    })
    assert.equal(result.exitCode, 0, result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git('init', '-q')
  git('add', '.')
  git(
    '-c',
    'user.name=Bunly fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture'
  )
  return { source, git, head: git('rev-parse', 'HEAD') }
}

// Real macOS preparation intentionally requires actual Mach-O signing inputs;
// this invalid-binary fixture covers the portable bundling and no-launch path.
test.skipIf(process.platform === 'darwin')(
  'prepare bundles only application assets; inert host/Bun/CEF inputs never execute and no-launch verifies source/artifacts',
  async () => {
    const work = await mkdtemp(join(tmpdir(), 'bunly-hardware-prepare-'))
    try {
      const selected = await fakePrebuilt(work)
      const { source, head, git } = await sourceFixture(work)
      const original = await inventory(selected.app)
      await assert.rejects(
        prepareHardwareWorkbench(source, selected.selection, 'f'.repeat(40)),
        /no implicit fetch/
      )
      await assert.rejects(prepareHardwareWorkbench(source, join(work, 'missing'), head))
      assert.equal((await readdir(source)).includes('.bunly'), false)
      const recordPath = await prepareHardwareWorkbench(source, selected.selection, head)
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
      assert.equal(record['guiLaunched'], false)
      assert.equal(record['nativeCompiled'], false)
      assert.equal(record['nativeFetched'], false)
      assert.equal(record['hardwareQualified'], false)
      assert.deepEqual(await inventory(selected.app), original)
      const operator = JSON.parse(
        await readFile(join(dirname(recordPath), 'operator-record.template.json'), 'utf8')
      ) as { cases: { status: string }[] }
      assert.equal(operator.cases.length, 12)
      assert.ok(
        operator.cases.every((row) => row.status === 'not run' || row.status === 'unsupported')
      )
      const prepared = await inspectPreparedWorkbench(source, recordPath)
      await runHardwareWorkbench(source, recordPath, false)
      assert.equal(
        (await readdir(prepared.work)).some((name) => name.startsWith('session-')),
        false
      )
      assert.equal((await readdir(join(source, 'native/cef-host'))).includes('target'), false)
      const publicRoot = join(prepared.app, 'resources/public')
      for (const name of [
        'index.html',
        'overlay.html',
        'preview.html',
        'client.js',
        'page.js',
        'workbench.css',
        'assets.json',
      ])
        assert.ok((await readFile(join(publicRoot, name))).length > 0)
      await writeFile(join(publicRoot, 'page.js'), 'changed')
      await assert.rejects(inspectPreparedWorkbench(source, recordPath), /bytes or links changed/)
      await writeFile(join(source, 'native/cef-host/source.txt'), 'different native source\n')
      git('add', '.')
      git(
        '-c',
        'user.name=Bunly fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'different-native'
      )
      await assert.rejects(
        prepareHardwareWorkbench(source, selected.selection, head),
        /native source tree mismatch/
      )
      await writeFile(join(source, 'dirty.ts'), 'export {}\n')
      await assert.rejects(
        prepareHardwareWorkbench(source, selected.selection, git('rev-parse', 'HEAD')),
        /clean committed source/
      )
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  },
  30_000
)

test.skipIf(process.platform === 'win32')(
  'private preparation refuses a linked output parent before writing into another directory',
  async () => {
    const work = await mkdtemp(join(tmpdir(), 'bunly-hardware-output-'))
    try {
      const selected = await fakePrebuilt(work)
      const { source, head } = await sourceFixture(work)
      const outside = join(work, 'outside')
      await mkdir(outside)
      await mkdir(join(source, '.bunly'))
      await symlink(outside, join(source, '.bunly/m7'))
      await assert.rejects(
        prepareHardwareWorkbench(source, selected.selection, head),
        /must not be linked/
      )
      assert.deepEqual(await readdir(outside), [])
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  },
  30_000
)
