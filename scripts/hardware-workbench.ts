/** Prepare only by default. Native compilation, acquisition and automatic GUI launch are absent. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { capturePreparedFileMetadata } from '../benchmarks/reload/prepared-file-metadata.ts'
import { equipmentRecordTemplate } from '../examples/hardware-workbench/cases.ts'
import { prepareManagedRuntimeLayout } from './qualify-managed-development.ts'

const ROOT = resolve(import.meta.dir, '..')
const targets = ['darwin-arm64', 'linux-x64', 'win32-x64'] as const
type Target = (typeof targets)[number]
const selectors = [
  'examples/hardware-workbench',
  'packages/contracts/src',
  'packages/client/src',
  'packages/runtime/src',
  'scripts/hardware-workbench.ts',
  'scripts/cef-bootstrap.ts',
  'scripts/qualify-managed-development.ts',
  'scripts/qualify_adhoc_signing.py',
  'scripts/native_signing.py',
  'scripts/native_signing_policy.py',
  'benchmarks/lib/inventory.ts',
  'benchmarks/lib/source-identity.ts',
  'benchmarks/reload/prepared-file-metadata.ts',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'tsconfig.browser.json',
] as const
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const usage =
  'Use hardware-workbench prepare PREBUILT_APP --native-source=FULL_COMMIT, or hardware-workbench run PREPARATION_JSON [--launch]'
type Arguments =
  | { mode: 'prepare'; app: string; nativeSource: string }
  | { mode: 'run'; record: string; launch: boolean }

export function parseWorkbenchArguments(input: readonly string[]): Arguments {
  if (input[0] === 'prepare' && input.length === 3 && input[1] && isAbsolute(input[1])) {
    const commit = /^--native-source=([a-f0-9]{40})$/.exec(input[2]!)?.[1]
    if (commit) return { mode: 'prepare', app: input[1], nativeSource: commit }
  }
  if (
    input[0] === 'run' &&
    (input.length === 2 || (input.length === 3 && input[2] === '--launch')) &&
    input[1] &&
    isAbsolute(input[1])
  )
    return { mode: 'run', record: input[1], launch: input.length === 3 }
  throw new Error(usage)
}
function currentTarget(): Target {
  const target = `${process.platform}-${process.arch}` as Target
  assert.ok(targets.includes(target), 'Unsupported workbench target')
  return target
}
function paths(target: Target) {
  const mac = target === 'darwin-arm64'
  return {
    application: mac ? 'Hardware Workbench.app' : 'Hardware Workbench',
    host: mac
      ? 'Contents/MacOS/bunly_host'
      : target === 'win32-x64'
        ? 'bunly_host.exe'
        : 'bunly_host',
    bun: mac
      ? 'Contents/Resources/bun'
      : target === 'win32-x64'
        ? 'resources/bun.exe'
        : 'resources/bun',
    resources: mac ? 'Contents/Resources' : 'resources',
    library: mac
      ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
      : target === 'win32-x64'
        ? 'libcef.dll'
        : 'libcef.so',
  }
}
function inside(parent: string, candidate: string): boolean {
  const parts = relative(parent, candidate).split(sep)
  return !isAbsolute(relative(parent, candidate)) && parts[0] !== '..'
}
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5000,
  })
  assert.equal(result.exitCode, 0, 'Required local Git object is missing; no implicit fetch')
  return result.stdout.toString().trim()
}
async function regular(path: string): Promise<void> {
  const info = await lstat(path)
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size > 0,
    'Expected a nonempty regular file'
  )
}
async function boundedJson(path: string): Promise<unknown> {
  await regular(path)
  assert.ok((await lstat(path)).size <= 32 * 1024 * 1024, 'Record is too large')
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
  ) as unknown
}

export function validateWorkbenchRuntime(input: unknown): void {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Invalid runtime manifest')
  const runtime = input as Record<string, unknown>
  assert.ok(
    Object.keys(runtime).every((key) =>
      [
        'schema',
        'protocol',
        'bun_version',
        'cef_version',
        'maintenance_protocol',
        'qualification_profile',
      ].includes(key)
    ),
    'Workbench requires the standard packaged runtime without development origin or credential policy'
  )
  assert.equal(runtime['schema'], 1)
  assert.equal(runtime['protocol'], 1)
  assert.equal(runtime['bun_version'], '1.4.4')
  assert.equal(runtime['cef_version'], '156.0.7')
  assert.ok(runtime['maintenance_protocol'] === undefined || runtime['maintenance_protocol'] === 1)
  assert.ok(
    runtime['qualification_profile'] === undefined ||
      runtime['qualification_profile'] === 'standard',
    'Do not widen native deadlines for hardware testing'
  )
}

/** Internal relative framework links are retained. Escaping links and mutable-path aliases reject. */
export async function validateWorkbenchInput(
  app: string,
  target: Target
): Promise<{ root: string; artifact: Awaited<ReturnType<typeof inventory>> }> {
  assert.ok(isAbsolute(app), 'Select an absolute prebuilt application path')
  const layout = paths(target)
  const inputInfo = await lstat(app)
  assert.ok(!inputInfo.isSymbolicLink(), 'Prebuilt selection cannot be a symlink')
  if (target === 'darwin-arm64')
    assert.ok(inputInfo.isDirectory() && app.endsWith('.app'), 'Select a prepared .app directory')
  else
    assert.ok(
      inputInfo.isFile() && basename(app) === layout.host,
      'Select the packaged native host executable'
    )
  const inputRoot = await realpath(target === 'darwin-arm64' ? app : dirname(app))
  const artifact = await inventory(inputRoot)
  for (const entry of artifact.entries) {
    if (entry.kind !== 'symlink') continue
    assert.ok(entry.target && !isAbsolute(entry.target), 'Absolute artifact link rejected')
    assert.ok(
      inside(inputRoot, await realpath(join(inputRoot, entry.path))),
      'Artifact link escapes input root'
    )
    assert.ok(
      !entry.path.startsWith(layout.resources + '/'),
      'Application resources must not contain links'
    )
  }
  for (const directory of target === 'darwin-arm64'
    ? ['Contents', layout.resources, 'Contents/MacOS']
    : [layout.resources]) {
    const info = await lstat(join(inputRoot, directory))
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Linked application directory rejected')
  }
  await regular(join(inputRoot, layout.host))
  await regular(join(inputRoot, layout.bun))
  // The macOS framework's public library is normally an internal symlink.
  const library = await realpath(join(inputRoot, layout.library))
  assert.ok(inside(inputRoot, library))
  await regular(library)
  const config = join(inputRoot, layout.resources, 'runtime.json')
  assert.ok((await lstat(config)).size <= 4096, 'Runtime manifest too large')
  validateWorkbenchRuntime(await boundedJson(config))
  return { root: inputRoot, artifact }
}

async function privateOutputParent(root: string): Promise<string> {
  let current = root
  for (const part of ['.bunly', 'm7', 'hardware-workbench']) {
    current = join(current, part)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(current)
    assert.ok(
      info.isDirectory() && !info.isSymbolicLink(),
      'Private output parent must not be linked'
    )
  }
  return current
}

/** Only Bun/browser bundling and controlled asset copying; no native toolchain path. */
export async function buildHardwareWorkbench(root: string, resources: string): Promise<void> {
  const backend = join(resources, 'backend'),
    publicRoot = join(resources, 'public')
  for (const path of [backend, publicRoot]) {
    await rm(path, { recursive: true, force: true })
    await mkdir(path)
  }
  await cp(join(root, 'examples/hardware-workbench/public'), publicRoot, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  })
  for (const [entry, outdir, name, target] of [
    ['scripts/cef-bootstrap.ts', backend, 'main.js', 'bun'],
    ['examples/hardware-workbench/main.ts', backend, 'application.js', 'bun'],
    ['examples/hardware-workbench/client.ts', publicRoot, 'client.js', 'browser'],
    ['examples/hardware-workbench/page.ts', publicRoot, 'page.js', 'browser'],
  ] as const) {
    const build = await Bun.build({
      entrypoints: [join(root, entry)],
      outdir,
      naming: name,
      target,
      format: 'esm',
      minify: false,
    })
    assert.equal(build.success, true, build.logs.join('\n'))
  }
  const assets: Record<string, { bytes: number; sha256: string }> = {}
  for (const entry of (await inventory(publicRoot)).entries) {
    assert.equal(entry.kind, 'file')
    assert.ok(entry.sha256)
    assets[entry.path] = { bytes: entry.bytes, sha256: entry.sha256 }
  }
  assert.equal(assets['assets.json'], undefined)
  await writeFile(join(publicRoot, 'assets.json'), JSON.stringify(assets, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
}

async function fingerprints(root: string, commit: string) {
  const files = git(root, 'ls-tree', '-r', '--name-only', commit, '--', ...selectors)
    .split('\n')
    .filter(Boolean)
  assert.ok(files.length > 0, 'Missing workbench sources')
  return Promise.all(
    files.map(async (path) => {
      await regular(join(root, path))
      return { path, sha256: digest(await readFile(join(root, path))) }
    })
  )
}
async function signCopy(root: string, work: string, app: string): Promise<void> {
  // Existing repository policy supplies an inside-out plan and explicit ad-hoc flags.
  // No key selection, trust-store update, timestamp service or OS application launch.
  const script = join(work, 'sign-copy.py')
  await writeFile(
    script,
    [
      'import subprocess,sys',
      'from pathlib import Path',
      `sys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})`,
      'from qualify_adhoc_signing import targets,sign_command',
      `app=Path(${JSON.stringify(app)})`,
      'for target in targets(app): subprocess.run(sign_command(target),check=True,capture_output=True,timeout=30)',
      "subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True,capture_output=True,timeout=30)",
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 }
  )
  const child = Bun.spawn([process.env['PYTHON'] ?? 'python3', script], {
    cwd: work,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  const [code] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ])
  assert.equal(code, 0, 'Ad-hoc signing of private workbench copy failed')
}

export async function prepareHardwareWorkbench(
  root: string,
  input: string,
  nativeSource: string
): Promise<string> {
  assert.equal(Bun.version, '1.4.4', 'Use pinned Bun 1.4.4')
  assert.match(nativeSource, /^[a-f0-9]{40}$/, 'Explicit full native build commit required')
  const target = currentTarget(),
    layout = paths(target)
  const before = sourceIdentity(root)
  assert.ok(before.clean && before.commit, 'Preparation requires clean committed source')
  const nativeTree = git(root, 'rev-parse', `${nativeSource}:native/cef-host`)
  assert.equal(
    nativeTree,
    git(root, 'rev-parse', `${before.commit}:native/cef-host`),
    'Prebuilt native source tree mismatch'
  )
  const selected = await validateWorkbenchInput(input, target)
  const outputBase = join(root, '.bunly/m7/hardware-workbench')
  assert.ok(
    !inside(selected.root, outputBase) && !inside(outputBase, selected.root),
    'Input and prepared output must not overlap'
  )
  const sources = await fingerprints(root, before.commit)
  const parent = await privateOutputParent(root)
  const work = await mkdtemp(join(parent, 'prepared-'))
  const app = join(work, layout.application)
  try {
    await cp(selected.root, app, { recursive: true, dereference: false, verbatimSymlinks: true })
    assert.deepEqual(
      await inventory(app),
      selected.artifact,
      'Prebuilt copy differs before bundling'
    )
    await prepareManagedRuntimeLayout(app)
    await buildHardwareWorkbench(root, join(app, layout.resources))
    if (target === 'darwin-arm64') await signCopy(root, work, app)
    const prepared = await inventory(app)
    assert.deepEqual(await inventory(selected.root), selected.artifact, 'Original prebuilt changed')
    assert.deepEqual(sourceIdentity(root), before, 'Source changed during preparation')
    assert.deepEqual(
      await fingerprints(root, before.commit),
      sources,
      'Source bytes changed during preparation'
    )
    const record = {
      schema: 1,
      profile: 'native-hardware-workbench-v1',
      status: 'prepared-only',
      target,
      source: before,
      sourceHashes: sources,
      nativeSource: {
        declaredCommit: nativeSource,
        tree: nativeTree,
        embeddedBuildAttestation: false,
      },
      developerBun: Bun.version,
      packagedBun: { declared: '1.4.4', observed: null },
      cef: { declared: '156.0.7', exportedIdentity: null },
      application: layout.application,
      hostPath: layout.host,
      inputArtifact: selected.artifact,
      preparedArtifact: prepared,
      preparedMetadata: await capturePreparedFileMetadata(app, prepared.entries),
      originalUnchanged: true,
      nativeCompiled: false,
      nativeFetched: false,
      guiLaunched: false,
      hardwareQualified: false,
      performanceEligible: false,
      macSigning:
        target === 'darwin-arm64' ? 'private-copy-ad-hoc-not-release-signing' : 'not-applicable',
      limitations: [
        'The native build commit is declared by the operator, not embedded build attestation.',
        'Preparation does not execute the packaged Bun, native host or CEF library.',
        'Run the separate exact-head native suite for runtime identity and process/helper cleanup evidence.',
        'Physical input, IME, high DPI, multiple displays, assistive technology and suspend/resume remain not run.',
      ],
    }
    const recordPath = join(work, 'preparation.json')
    const bytes = JSON.stringify(record, null, 2) + '\n'
    await writeFile(recordPath, bytes, { flag: 'wx', mode: 0o600 })
    await writeFile(
      join(work, 'operator-record.template.json'),
      JSON.stringify(
        {
          ...equipmentRecordTemplate(),
          preparation: {
            source: before.commit,
            nativeBuild: nativeSource,
            nativeTree,
            profile: record.profile,
            target,
            sha256: digest(bytes),
          },
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
    return recordPath
  } catch (error) {
    // Keep the failed private copy for diagnosis; never publish a launchable preparation receipt.
    await writeFile(
      join(work, 'preparation-failed.json'),
      JSON.stringify({
        schema: 1,
        status: 'failed',
        guiLaunched: false,
        hardwareQualified: false,
        reason: error instanceof Error ? error.message.slice(0, 512) : 'Preparation failed',
      }) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
    throw error
  }
}

export async function inspectPreparedWorkbench(root: string, path: string) {
  const record = (await boundedJson(path)) as Record<string, unknown>
  assert.equal(record['schema'], 1)
  assert.equal(record['profile'], 'native-hardware-workbench-v1')
  assert.equal(record['status'], 'prepared-only')
  assert.equal(record['target'], currentTarget())
  for (const field of [
    'nativeCompiled',
    'nativeFetched',
    'guiLaunched',
    'hardwareQualified',
    'performanceEligible',
  ])
    assert.equal(record[field], false)
  const layout = paths(currentTarget())
  assert.equal(record['application'], layout.application)
  assert.equal(record['hostPath'], layout.host)
  const source = record['source'] as { commit?: unknown; clean?: unknown }
  assert.ok(
    source &&
      source.clean === true &&
      typeof source.commit === 'string' &&
      /^[a-f0-9]{40}$/.test(source.commit)
  )
  assert.deepEqual(
    sourceIdentity(root),
    source,
    'Use the unchanged source checkout that prepared this application'
  )
  const native = record['nativeSource'] as { declaredCommit?: unknown; tree?: unknown }
  assert.ok(
    native &&
      typeof native.declaredCommit === 'string' &&
      /^[a-f0-9]{40}$/.test(native.declaredCommit)
  )
  assert.equal(git(root, 'rev-parse', `${native.declaredCommit}:native/cef-host`), native.tree)
  assert.equal(git(root, 'rev-parse', `${source.commit}:native/cef-host`), native.tree)
  assert.deepEqual(await fingerprints(root, source.commit), record['sourceHashes'])
  const work = dirname(await realpath(path)),
    app = join(work, layout.application)
  const validated = await validateWorkbenchInput(
    currentTarget() === 'darwin-arm64' ? app : join(app, layout.host),
    currentTarget()
  )
  assert.deepEqual(
    validated.artifact,
    record['preparedArtifact'],
    'Prepared application bytes or links changed'
  )
  assert.deepEqual(
    await capturePreparedFileMetadata(app, validated.artifact.entries),
    record['preparedMetadata'],
    'Prepared application identity or metadata changed; prepare a new copy'
  )
  return {
    work,
    app,
    executable: join(app, layout.host),
    recordSha256: digest(await readFile(path)),
    inventory: validated.artifact,
  }
}

/** Explicit launch has no fixture timeout. Only native deadlines govern each native operation. */
export async function runHardwareWorkbench(
  root: string,
  recordPath: string,
  launch: boolean
): Promise<void> {
  const prepared = await inspectPreparedWorkbench(root, recordPath)
  if (!launch) {
    console.log(
      JSON.stringify({
        status: 'verified-not-launched',
        preparation: recordPath,
        launchArguments: ['run', recordPath, '--launch'],
        hardwareQualified: false,
      })
    )
    return
  }
  assert.ok(
    process.platform === 'win32' || process.getuid?.() !== 0,
    'Launch as a standard desktop user'
  )
  const run = await mkdtemp(join(prepared.work, 'session-'))
  const environment = { ...process.env }
  // Do not inherit other contributor fault/profile/credential controls into an interactive session.
  for (const key of Object.keys(environment)) if (key.startsWith('BUNLY_')) delete environment[key]
  environment['BUNLY_CACHE_DIR'] = join(run, 'cache')
  const started = new Date().toISOString()
  await writeFile(
    join(run, 'launch.json'),
    JSON.stringify(
      {
        schema: 1,
        status: 'running',
        started,
        preparationSha256: prepared.recordSha256,
        executable: relative(prepared.work, prepared.executable),
        arguments: [],
        nativeCompiled: false,
        nativeFetched: false,
        hardwareQualified: false,
      },
      null,
      2
    ) + '\n',
    { flag: 'wx', mode: 0o600 }
  )
  console.log(
    `Interactive native session. Close its final window to finish. Session record: ${run}`
  )
  const child = Bun.spawn([prepared.executable], {
    cwd: run,
    env: environment,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    child.kill('SIGTERM')
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  let code: number
  try {
    code = await child.exited
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  const after = await inventory(prepared.app)
  const unchanged = JSON.stringify(after) === JSON.stringify(prepared.inventory)
  await writeFile(
    join(run, 'exit.json'),
    JSON.stringify(
      {
        schema: 1,
        started,
        ended: new Date().toISOString(),
        exitCode: code,
        interrupted,
        preparedBytesUnchanged: unchanged,
        preparationSha256: prepared.recordSha256,
        hardwareQualified: false,
        nativeAcceptanceQualified: false,
        helperCleanupQualified: false,
        manualResults: 'record-separately',
        limitation:
          'Root process exit alone does not prove native/helper cleanup or pass an operator case.',
      },
      null,
      2
    ) + '\n',
    { flag: 'wx', mode: 0o600 }
  )
  assert.ok(unchanged, 'Prepared bytes changed; preserve this attempt and investigate')
  if (code !== 0 || interrupted) process.exitCode = 1
}

if (import.meta.main) {
  const args = parseWorkbenchArguments(process.argv.slice(2))
  if (args.mode === 'prepare')
    console.log(
      JSON.stringify({
        status: 'prepared-only',
        preparation: await prepareHardwareWorkbench(ROOT, args.app, args.nativeSource),
        guiLaunched: false,
        hardwareQualified: false,
      })
    )
  else await runHardwareWorkbench(ROOT, args.record, args.launch)
}
