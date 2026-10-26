/** One native window-mode sequence against an immutable prepared application. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import { acceptWindowModes } from '../benchmarks/lib/cef-window-acceptance.ts'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const input = args.shift()
if (!input || args.length || Bun.version !== '1.4.3')
  throw new Error('Use Bun 1.4.3: qualify-cef-window-modes PREPARED_APP')
const mac = process.platform === 'darwin'
const source = resolve(input)
const inputRoot = mac ? source : dirname(source)
const inputInventory = await inventory(inputRoot)
const parent = join(root, '.bunly/m5/window-modes')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
const sourcePaths = [
  'package.json',
  'bun.lock',
  'scripts/qualify-cef-window-modes.ts',
  'scripts/cef-bootstrap.ts',
  'examples/cef-window-state/fixture.ts',
  'examples/cef-window-state/client.ts',
  'examples/cef-window-state/contract.ts',
  'examples/cef-window-state/public/index.html',
  'benchmarks/lib/cef-window-acceptance.ts',
  'benchmarks/lib/observed-command.ts',
  'benchmarks/lib/native-diagnostic-events.json',
  'benchmarks/foundation/native-shutdown.ts',
  'packages/runtime/src/cef.ts',
  'packages/runtime/src/cef-lane-transport.ts',
  'packages/runtime/src/fair-scheduler.ts',
  'packages/runtime/src/cef-window-state.ts',
  'native/cef-host/src/host.rs',
  'native/cef-host/src/window_state.rs',
  'native/cef-host/Cargo.toml',
  'native/cef-host/src/process.rs',
]
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ])
    )
  )
const before = sourceIdentity(root)
const report: Record<string, unknown> = {
  schema: 1,
  classification: 'native-window-mode-prerequisite',
  passed: false,
  target: `${process.platform}-${process.arch}`,
  bun: Bun.version,
  sourceBefore: before,
  sourceHashes: await fingerprints(),
  inputArtifact: inputInventory,
  limitations: [
    'One functional window-mode sequence, not combined terminal load or performance qualification.',
    'Native active, visible and minimized states are independent; page visibility is separately observed.',
    'Current-head macOS/Linux/Windows execution remains required for cross-platform acceptance.',
  ],
}
const python = process.env['PYTHON'] ?? 'python3'
try {
  const app = join(work, mac ? 'Window Modes.app' : 'Window Modes Unicode é Ω')
  await cp(inputRoot, app, { recursive: true, dereference: false })
  const resources = join(app, mac ? 'Contents/Resources' : 'resources')
  const runtime = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')) as Record<
    string,
    unknown
  >
  assert.equal(
    runtime['development_origin'],
    undefined,
    'Prepared app must not use a development origin'
  )
  assert.equal(runtime['bun_version'], '1.4.3')
  assert.equal(runtime['cef_version'], '156.0.7')

  const bootstrap = await Bun.build({
    entrypoints: [join(root, 'scripts/cef-bootstrap.ts')],
    outdir: join(resources, 'backend'),
    naming: 'main.js',
    target: 'bun',
    format: 'esm',
    minify: false,
  })
  assert.equal(bootstrap.success, true, bootstrap.logs.join('\n'))

  const backend = await Bun.build({
    entrypoints: [join(root, 'examples/cef-window-state/fixture.ts')],
    outdir: join(resources, 'backend'),
    naming: 'application.js',
    target: 'bun',
    format: 'esm',
    minify: false,
  })
  assert.equal(backend.success, true, backend.logs.join('\n'))
  const publicRoot = join(resources, 'public')
  await rm(publicRoot, { recursive: true, force: true })
  await mkdir(publicRoot)
  await cp(
    join(root, 'examples/cef-window-state/public/index.html'),
    join(publicRoot, 'index.html')
  )
  const browser = await Bun.build({
    entrypoints: [join(root, 'examples/cef-window-state/client.ts')],
    outdir: publicRoot,
    naming: 'client.js',
    target: 'browser',
    format: 'esm',
    minify: false,
  })
  assert.equal(browser.success, true, browser.logs.join('\n'))
  const assets: Record<string, { bytes: number; sha256: string }> = {}
  for (const name of (await readdir(publicRoot)).sort()) {
    const path = join(publicRoot, name)
    const stat = await lstat(path)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Public assets must be regular files')
    const bytes = await readFile(path)
    assets[name] = {
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  await writeFile(join(publicRoot, 'assets.json'), JSON.stringify(assets, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })

  if (mac) {
    const signer = join(work, 'sign.py')
    await writeFile(
      signer,
      [
        'import sys,subprocess',
        'from pathlib import Path',
        `sys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})`,
        'from qualify_adhoc_signing import targets',
        `for p in targets(Path(${JSON.stringify(app)})): subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(p)],check=True,capture_output=True)`,
        '',
      ].join('\n'),
      { mode: 0o600 }
    )
    assertCleanCommand(
      await observedCommand([python, signer], {
        cwd: root,
        output: join(work, 'sign.process.json'),
        timeoutMs: 30_000,
      }).result
    )
  }
  const prepared = await inventory(app)
  report['preparedArtifact'] = prepared
  report['assets'] = assets
  const library = join(
    app,
    mac
      ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
      : process.platform === 'win32'
        ? 'libcef.dll'
        : 'libcef.so'
  )
  const libraryHash = new Bun.CryptoHasher('sha256')
    .update(await Bun.file(library).arrayBuffer())
    .digest('hex')
  const identity = await observedCommand(
    [
      python,
      join(root, 'scripts/probe_cef_identity.py'),
      '--library',
      library,
      '--sha256',
      libraryHash,
    ],
    { cwd: work, output: join(work, 'identity.process.json'), timeoutMs: 30_000 }
  ).result
  assertCleanCommand(identity)
  const identityLine = identity.stdoutTail.find((line) => line.startsWith('{'))
  assert.ok(identityLine)
  report['runtimeIdentity'] = JSON.parse(identityLine)
  const executable = mac ? join(app, 'Contents/MacOS/bunly_host') : join(app, basename(source))
  const observation = await observedCommand([executable], {
    cwd: work,
    output: join(work, 'trial.process.json'),
    timeoutMs: 30_000,
    env: { BUNLY_CACHE_DIR: join(work, 'cache'), BUNLY_BENCH_SANDBOX: '1' },
  }).result
  report['observation'] = observation
  report['modes'] = acceptWindowModes(observation)
  assert.deepEqual(await inventory(app), prepared, 'Prepared artifact changed during qualification')
  assert.deepEqual(
    await inventory(inputRoot),
    inputInventory,
    'Input artifact changed during qualification'
  )
  report['preparedArtifactUnchanged'] = true
  report['inputArtifactUnchanged'] = true
  report.passed = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
} finally {
  const after = sourceIdentity(root)
  report['sourceAfter'] = after
  report['sourceHashesAfter'] = await fingerprints().catch((error) => ({ failure: String(error) }))
  if (JSON.stringify(report['sourceHashes']) !== JSON.stringify(report['sourceHashesAfter'])) {
    report.passed = false
    report['failure'] = 'Qualifier sources changed during execution'
  }
  const output = join(work, 'report.json')
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ passed: report.passed, output, failure: report['failure'] }))
}
if (!report.passed) process.exitCode = 1
