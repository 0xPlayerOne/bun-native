/** Run an already built runtime from a private Unicode installation with no compiler PATH. */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rename, writeFile, lstat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import {
  acceptNativeSmoke,
  acceptNativeRejection,
  nativeEvents,
} from '../benchmarks/lib/cef-acceptance.ts'
const root = resolve(import.meta.dir, '..'),
  sourceArgument = process.argv[2]
if (!sourceArgument || process.argv.length !== 3)
  throw new Error('Usage: bun scripts/qualify-cef-prebuilt.ts <app-directory-or-native-executable>')
if (!['darwin-arm64', 'linux-x64', 'win32-x64'].includes(`${process.platform}-${process.arch}`))
  throw new Error('Unsupported M3 target; native execution is never silently emulated')
const source = resolve(sourceArgument),
  mac = process.platform === 'darwin'
if ((await lstat(source)).isSymbolicLink())
  throw new Error('Prebuilt entry must not be a symbolic link')
const sourceDirectory = mac ? source : dirname(source)
const original = await inventory(sourceDirectory)
const parent = join(root, '.bunly/m3/prebuilt')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
const application = join(work, mac ? 'Bunly Unicode é Ω.app' : 'Bunly Unicode é Ω')
const unrelated = join(work, 'unrelated working directory'),
  emptyPath = join(work, 'empty-compiler-path')
await mkdir(unrelated)
await mkdir(emptyPath)
const sourceBefore = sourceIdentity(root)
const trials: Record<string, unknown>[] = []
const report: Record<string, unknown> = {
  schema: 1,
  target: `${process.platform}-${process.arch}`,
  sourceBefore,
  profile: 'prebuilt-unicode-installation-and-startup-rejection',
  classification: 'native-functional-acceptance',
  passed: false,
  trials,
  noCompilerPath: true,
  limitations: [
    'macOS uses a local ad-hoc signed prebuild, not distribution signing',
    'Other platforms must execute this runner natively; cross-compilation is not acceptance',
    'No hardware GPU, DPI-change or accessibility conformance is inferred',
  ],
}
try {
  await cp(sourceDirectory, application, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  })
  const executable = mac
    ? join(application, 'Contents/MacOS/bunly_host')
    : join(application, basename(source))
  const resources = join(application, mac ? 'Contents/Resources' : 'resources')
  async function execute(
    name: string,
    args: string[] = [],
    changes: Record<string, string | undefined> = {}
  ) {
    const observation = await observedCommand([executable, ...args], {
      cwd: unrelated,
      output: join(work, name + '.process.json'),
      timeoutMs: 60000,
      env: {
        PATH: emptyPath,
        BUNLY_CACHE_DIR: join(work, name + '-profile'),
        BUNLY_BENCH_SANDBOX: '1',
        ...changes,
      },
    }).result
    trials.push({ name, observation })
    return observation
  }
  for (let trial = 0; trial < 3; trial++) acceptNativeSmoke(await execute('installed-' + trial))
  const lastWindow = await execute('last-window', [], { BUNLY_TEST_LAST_WINDOW: '1' })
  acceptNativeSmoke(lastWindow)
  assert.ok(
    nativeEvents(lastWindow).some(
      (event) => event['event'] === 'bunly.native.last-window' && event['passed'] === true
    )
  )
  for (const argument of ['--no-sandbox', '--disable-web-security', '--remote-debugging-port=9222'])
    acceptNativeRejection(
      await execute('rejected-' + trials.length, [argument]),
      'Unsafe command-line'
    )
  const configPath = join(resources, 'runtime.json'),
    config = await readFile(configPath)
  try {
    await writeFile(
      configPath,
      JSON.stringify({ ...JSON.parse(config.toString()), cef_version: '0.0.0' })
    )
    acceptNativeRejection(await execute('wrong-version'), 'Runtime/ABI manifest mismatch')
  } finally {
    await writeFile(configPath, config)
  }
  const bun = join(resources, process.platform === 'win32' ? 'bun.exe' : 'bun')
  await rename(bun, bun + '.absent')
  try {
    acceptNativeRejection(await execute('missing-bun'), 'Installed Bun or backend missing')
  } finally {
    await rename(bun + '.absent', bun)
  }
  if (process.platform === 'linux') {
    acceptNativeRejection(
      await execute('missing-display', [], { DISPLAY: undefined }),
      'requires an X11 DISPLAY'
    )
    const library = join(application, 'libcef.so')
    await rename(library, library + '.absent')
    try {
      const missing = await execute('missing-cef-library', [], { LD_LIBRARY_PATH: undefined })
      assertCleanCommand(missing, 127)
      assert.ok(
        missing.stderr.some((line) => /libcef\.so.*cannot open shared object file/.test(line)),
        'Missing native dependency must name the actual CEF library'
      )
      assert.equal(
        nativeEvents(missing).length,
        0,
        'The system loader must fail before host or browser startup'
      )
    } finally {
      await rename(library + '.absent', library)
    }
  }
  if (mac) {
    const helper = join(
      application,
      'Contents/Frameworks/bunly_host Helper (Renderer).app/Contents/MacOS/bunly_host Helper (Renderer)'
    )
    await rename(helper, helper + '.absent')
    try {
      acceptNativeRejection(await execute('missing-helper'), 'Missing packaged CEF helper')
    } finally {
      await rename(helper + '.absent', helper)
    }
  }
  acceptNativeSmoke(await execute('restored-installation'))
  assert.deepEqual(
    await inventory(sourceDirectory),
    original,
    'Qualification must not alter the input prebuild'
  )
  report['sourceArtifactUnchanged'] = true
  report['sourceAfter'] = sourceIdentity(root)
  report['installedBytes'] = (await inventory(application)).bytes
  report.passed = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
} finally {
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  })
  console.log(
    JSON.stringify({
      passed: report.passed,
      trials: trials.length,
      output: join(work, 'report.json'),
      failure: report['failure'],
    })
  )
}
if (!report.passed) process.exitCode = 1
