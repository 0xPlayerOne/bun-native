/** Fixed real native desktop soak against explicitly selected prebuilt artifacts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import {
  DevelopmentError,
  prepareDevelopmentHost,
  type DevelopmentHostInput,
} from '../packages/cli/src/dev-cache.ts'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'
import { assertCleanCommand, observedCommand } from '../benchmarks/lib/observed-command.ts'
import { reloadObservationResources } from '../benchmarks/reload/acceptance.ts'
import { managedObservationContentSha256 } from '../benchmarks/reload/managed-observation.ts'
import {
  capturePreparedFileMetadata,
  acceptPreparedFileMetadata,
} from '../benchmarks/reload/prepared-file-metadata.ts'
import { runManagedRestartCheck } from './managed-restart-check.ts'
import {
  MANAGED_OBSERVER_MS,
  MANAGED_PROFILE,
  acceptManagedDevelopmentReport,
  acceptManagedDevelopmentWorkload,
  managedSourceSelectors,
} from '../benchmarks/reload/managed-acceptance.ts'

const root = resolve(import.meta.dir, '..')
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
const mac = process.platform === 'darwin'
function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(result.exitCode, 0, 'Required local Git source object is missing')
  return result.stdout.toString().trim()
}
async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const stat = await lstat(path)
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum,
    'Invalid evidence file'
  )
  const bytes = await readFile(path)
  assert.equal(bytes.length, stat.size)
  return bytes
}
function nativePaths(app: string, source: string) {
  return {
    executable: mac ? join(app, 'Contents/MacOS/bunly_host') : join(app, basename(source)),
    resources: join(app, mac ? 'Contents/Resources' : 'resources'),
    library: join(
      app,
      mac
        ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
        : process.platform === 'win32'
          ? 'libcef.dll'
          : 'libcef.so'
    ),
  }
}
/** Complete the selected Linux runtime's static layout before publishing its
 * immutable cache inventory. Chromium 156's DIR_EXTERNAL_EXTENSIONS lookup
 * otherwise creates this empty directory beside libcef.so on first launch.
 * Existing contents are never removed or excluded from later verification.
 */
export async function prepareManagedRuntimeLayout(
  app: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform !== 'linux') return
  const rootInfo = await lstat(app)
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Invalid prepared runtime root')
  const extensions = join(app, 'extensions')
  try {
    await mkdir(extensions, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = await lstat(extensions)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Invalid static extensions directory')
  assert.equal((await readdir(extensions)).length, 0, 'Static extensions directory must be empty')
}
export async function buildManagedApplication(resources: string) {
  const backend = join(resources, 'backend')
  await rm(backend, { recursive: true, force: true })
  await mkdir(backend)
  const entries = [
    ['scripts/cef-bootstrap.ts', 'main.js'],
    ['examples/managed-desktop/main.ts', 'application.js'],
    ['packages/runtime/src/service-reload-runner.ts', 'service-reload-runner.js'],
    ['examples/managed-desktop/child.ts', 'managed-child.js'],
  ] as const
  const builds: Record<string, { source: string; bytes: number; sha256: string }> = {}
  for (const [source, name] of entries) {
    const built = await Bun.build({
      entrypoints: [join(root, source)],
      outdir: backend,
      naming: name,
      target: 'bun',
      format: 'esm',
      sourcemap: 'linked',
      minify: false,
    })
    assert.equal(built.success, true, 'Managed backend bundling failed')
    const bytes = await readFile(join(backend, name))
    builds[name] = { source, bytes: bytes.length, sha256: hash(bytes) }
  }
  const publicRoot = join(resources, 'public')
  await rm(publicRoot, { recursive: true, force: true })
  await cp(join(root, 'examples/managed-desktop/public'), publicRoot, {
    recursive: true,
    dereference: false,
  })
  const xterm = join(root, 'node_modules/@xterm/xterm')
  assert.equal(JSON.parse(await readFile(join(xterm, 'package.json'), 'utf8')).version, '5.5.0')
  await cp(join(xterm, 'css/xterm.css'), join(publicRoot, 'xterm.css'))
  await cp(join(xterm, 'LICENSE'), join(publicRoot, 'xterm-LICENSE.txt'))
  // The native public-origin policy intentionally rejects source maps. Keep
  // service maps in the private backend tree; publish only renderer assets here.
  for (const name of ['client', 'restart-client']) {
    const browser = await Bun.build({
      entrypoints: [join(root, `examples/managed-desktop/${name}.ts`)],
      outdir: publicRoot,
      naming: `${name}.js`,
      target: 'browser',
      format: 'esm',
      minify: false,
    })
    assert.equal(browser.success, true, 'Managed renderer bundling failed')
  }
  const assets: Record<string, { bytes: number; sha256: string }> = {}
  for (const entry of (await inventory(publicRoot)).entries) {
    assert.equal(entry.kind, 'file', 'Public assets must be regular files')
    assert.ok(entry.sha256)
    assets[entry.path] = { bytes: entry.bytes, sha256: entry.sha256 }
  }
  assert.equal(assets['assets.json'], undefined)
  await writeFile(join(publicRoot, 'assets.json'), JSON.stringify(assets, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
  return { builds, assets }
}
async function verify(path: string): Promise<void> {
  const bytes = await boundedFile(resolve(path), 32 * 1024 * 1024)
  const parsed = JSON.parse(bytes.toString()) as Record<string, unknown>
  const report = Object.hasOwn(parsed, 'nativeEvidenceExport')
    ? decodeExportedNativeReport(parsed)
    : parsed
  const acceptance = acceptManagedDevelopmentReport(report)
  const source = report['sourceBefore'] as { commit: string }
  const hashes = report['sourceHashes'] as { path: string; sha256: string }[]
  const expected = git(
    'ls-tree',
    '-r',
    '--name-only',
    source.commit,
    '--',
    ...managedSourceSelectors
  )
    .split('\n')
    .filter(Boolean)
  assert.deepEqual(
    hashes.map((item) => item.path).sort(),
    expected.sort(),
    'Incomplete historical source inventory'
  )
  for (const item of hashes) {
    const blob = Bun.spawnSync(['git', 'show', `${source.commit}:${item.path}`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    assert.equal(
      blob.exitCode,
      0,
      'Historical source missing; no implicit fetch or current-source substitution'
    )
    assert.equal(hash(blob.stdout), item.sha256, item.path)
  }
  const native = report['nativeSource'] as { declaredCommit: string; tree: string }
  assert.equal(git('rev-parse', `${native.declaredCommit}:native/cef-host`), native.tree)
  assert.equal(git('rev-parse', `${source.commit}:native/cef-host`), native.tree)
  console.log(
    JSON.stringify({
      profile: MANAGED_PROFILE + '-retained-replay',
      acceptance,
      source: source.commit,
      reportSha256: hash(bytes),
      performanceEligible: false,
    })
  )
}

async function qualify(args: readonly string[]): Promise<void> {
  assert.equal(Bun.version, '1.4.4', 'Use pinned Bun 1.4.4')
  assert.equal(
    args.length,
    2,
    'Use qualify-managed-development PREBUILT_APP --native-source=COMMIT, or --verify REPORT'
  )
  const source = resolve(args[0]!)
  const selectedSource = /^--native-source=([a-f0-9]{40})$/.exec(args[1]!)?.[1]
  assert.ok(selectedSource, 'An explicit immutable native build source is required')
  assert.ok(
    process.platform === 'win32' || process.getuid?.() !== 0,
    'Native qualification requires a standard user'
  )
  const before = sourceIdentity(root)
  assert.equal(before.clean, true, 'Native qualification requires clean committed source')
  assert.ok(before.commit)
  const nativeTree = git('rev-parse', `${selectedSource}:native/cef-host`)
  assert.equal(
    nativeTree,
    git('rev-parse', `${before.commit}:native/cef-host`),
    'Prebuilt native source differs from current native source'
  )
  const sourcePaths = git(
    'ls-tree',
    '-r',
    '--name-only',
    before.commit,
    '--',
    ...managedSourceSelectors
  )
    .split('\n')
    .filter(Boolean)
  const fingerprints = async () =>
    Promise.all(
      sourcePaths.map(async (path) => ({ path, sha256: hash(await readFile(join(root, path))) }))
    )
  const parent = join(root, '.bunly/m6/managed-development')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const work = await mkdtemp(join(parent, 'run-'))
  const report: Record<string, unknown> = {
    schema: 1,
    profile: MANAGED_PROFILE,
    passed: false,
    target: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    sourceBefore: before,
    sourceHashes: await fingerprints(),
    nativeSource: {
      declaredCommit: selectedSource,
      tree: nativeTree,
      provenance: 'explicit-caller-selected-build-source-with-identical-current-native-tree',
      limitation:
        'Prebuilt binary has no embedded source attestation; the full selected byte inventory and caller build-source declaration are retained separately.',
    },
    observerTimeoutMs: MANAGED_OBSERVER_MS,
    successfulReplacementPlan: 500,
    launchPlan: 1,
    restartLaunchPlan: 1,
    performanceEligible: false,
    comparisons: 'separate-matched-workflow-qualification-required',
    trials: [],
    operations: [],
    limitations: [
      'One sequential native soak launch with 500 successful backend replacements plus one separate controlled full relaunch; not 500 independent launches or a population latency confidence interval.',
      'Native watchdog, shutdown, sandbox, security cloning, helper qualification and credential policies are unchanged.',
      'Descriptor/RSS/process data is sampled; short child lifetimes can be missed, RSS can count shared pages more than once, and unavailable reads remain null.',
      'Main-isolate post-GC heap includes bundling/controller work and excludes Worker heaps. The predeclared finite retention sentinel does not establish universal leak freedom.',
      'Frontend callback acknowledgement does not establish compatibility with every third-party HMR protocol.',
      'No comparative speed claim or release certification is inferred. Historical CEF watchdog failures remain failures.',
    ],
  }
  const operations = report['operations'] as Record<string, unknown>[]
  const trials = report['trials'] as Record<string, unknown>[]
  const python = process.env['PYTHON'] ?? 'python3'
  report['restart'] = {
    attempted: false,
    passed: false,
    reason: 'Prepared host and fixed soak have not passed; no follow-up launch admitted',
  }
  try {
    const inputRoot = mac ? source : dirname(source)
    const inputInventory = await inventory(inputRoot)
    report['inputArtifact'] = inputInventory
    const original = nativePaths(inputRoot, source)
    const runtime = JSON.parse(
      await readFile(join(original.resources, 'runtime.json'), 'utf8')
    ) as Record<string, unknown>
    assert.equal(
      runtime['development_origin'],
      undefined,
      'Use a packaged prebuilt host without an implicit development origin'
    )
    assert.equal(runtime['bun_version'], '1.4.4')
    assert.equal(runtime['cef_version'], '156.0.7')
    assert.equal(runtime['protocol'], 1)
    const hostEntry = inputInventory.entries.find(
      (entry) => entry.path === relative(inputRoot, original.executable).split('\\').join('/')
    )
    assert.ok(hostEntry?.sha256)
    report['inputHostSha256'] = hostEntry.sha256
    const sourceHashes = report['sourceHashes'] as { path: string; sha256: string }[]
    const inputs: DevelopmentHostInput[] = inputInventory.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry, index) => ({
        name: `runtime:${index}`,
        path: join(inputRoot, entry.path),
        sha256: entry.sha256!,
      }))
    const stableSources = sourceHashes.filter(
      ({ path }) =>
        !path.startsWith('examples/managed-desktop/backend/') &&
        !path.startsWith('examples/managed-desktop/shared/') &&
        !path.startsWith('examples/managed-desktop/frontend/')
    )
    const identity = {
      appId: 'bunly.managed-development',
      nativeAbi: `protocol:${runtime['protocol']}`,
      engineVersion: `cef:${runtime['cef_version']}`,
      target: `${process.platform}-${process.arch}`,
      bunVersion: Bun.version,
      configuration: JSON.stringify({
        runtime,
        nativeTree,
        stableSourcesSha256: hash(JSON.stringify(stableSources)),
      }),
      inputs,
    }
    let assemblies = 0
    let built: Awaited<ReturnType<typeof buildManagedApplication>> | undefined
    const prepare = () =>
      prepareDevelopmentHost({
        cacheRoot: join(work, 'hosts'),
        identity,
        assemble: async (stage) => {
          assemblies++
          assert.equal(assemblies, 1, 'Warm preparation attempted another host assembly')
          const app = join(stage, mac ? 'Managed Development.app' : 'Managed Development')
          await cp(inputRoot, app, { recursive: true, dereference: false })
          await prepareManagedRuntimeLayout(app)
          operations.push({
            operation: 'copy-prebuilt-runtime',
            count: 1,
            bytes: inputInventory.bytes,
          })
          const paths = nativePaths(app, source)
          built = await buildManagedApplication(paths.resources)
          operations.push({ operation: 'bundle-stable-host', count: 1, nativeCompiler: false })
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
              { mode: 0o600, flag: 'wx' }
            )
            const signing = await observedCommand([python, signer], {
              cwd: root,
              output: join(work, 'sign.process.json'),
              timeoutMs: 30000,
            }).result
            assertCleanCommand(signing)
            report['adHocSigning'] = {
              passed: true,
              observationSha256: hash(await readFile(join(work, 'sign.process.json'))),
            }
            operations.push({
              operation: 'adhoc-sign-prepared-fixture',
              count: 1,
              productionSigning: false,
            })
          }
          return { entrypoint: relative(stage, paths.executable).split('\\').join('/') }
        },
      })
    const cold = await prepare()
    const cache: Record<string, unknown> = {
      key: cold.key,
      cold: {
        cacheHit: cold.cacheHit,
        durationMs: cold.durationMs,
        verifiedBytes: cold.verifiedBytes,
      },
      warm: { attempted: false },
      assemblies,
      warmNativeCopies: 0,
      warmNativeCompilations: 0,
      evidence:
        'cold-only-assembler-count-plus-unchanged-complete-runtime-inventory-and-file-metadata; launch-PATH-empty',
    }
    report['cache'] = cache
    assert.equal(cold.cacheHit, false)
    report['backendBuild'] = built
    const app = mac ? resolve(cold.entrypoint, '../../..') : dirname(cold.entrypoint)
    const paths = nativePaths(app, source)
    assert.equal(paths.executable, cold.entrypoint)
    const prepared = await inventory(app)
    const metadataBefore = await capturePreparedFileMetadata(app, prepared.entries)
    report['preparedArtifact'] = prepared
    report['preparedFileMetadataBefore'] = metadataBefore
    const hostPath = relative(app, paths.executable).split('\\').join('/')
    report['preparedHostPath'] = hostPath
    const bundledBun = join(paths.resources, process.platform === 'win32' ? 'bun.exe' : 'bun')
    const bunEntry = prepared.entries.find(
      (entry) => entry.path === relative(app, bundledBun).split('\\').join('/')
    )
    assert.ok(bunEntry?.sha256, 'Selected bundled Bun is absent from prepared inventory')
    const bunObservationPath = join(work, 'bun.process.json')
    const bunObservation = await observedCommand([bundledBun, '--version'], {
      cwd: work,
      output: bunObservationPath,
      timeoutMs: 30000,
      env: { PATH: '' },
    }).result
    assertCleanCommand(bunObservation)
    assert.deepEqual(bunObservation.stdoutTail, ['1.4.4'], 'Actual bundled Bun version differs')
    report['bundledBun'] = {
      version: '1.4.4',
      path: bunEntry.path,
      sha256: bunEntry.sha256,
      observation: bunObservation,
      observationSha256: hash(await readFile(bunObservationPath)),
      observationContentSha256: managedObservationContentSha256(bunObservation),
    }
    const libraryEntry = prepared.entries.find(
      (entry) => entry.path === relative(app, paths.library).split('\\').join('/')
    )
    assert.ok(libraryEntry?.sha256, 'Actual CEF library is absent from prepared inventory')
    const engine = await observedCommand(
      [
        python,
        join(root, 'scripts/probe_cef_identity.py'),
        '--library',
        paths.library,
        '--sha256',
        libraryEntry.sha256,
      ],
      { cwd: work, output: join(work, 'engine.process.json'), timeoutMs: 30000 }
    ).result
    assertCleanCommand(engine)
    const engineLines = engine.stdoutTail.filter((line) => {
      try {
        return JSON.parse(line).event === 'cef-binary-identity'
      } catch {
        return false
      }
    })
    assert.equal(engineLines.length, 1)
    report['runtimeIdentity'] = JSON.parse(engineLines[0]!)
    const project = join(work, 'application-source')
    await mkdir(project, { mode: 0o700 })
    for (const directory of ['backend', 'shared', 'frontend'])
      await cp(join(root, 'examples/managed-desktop', directory), join(project, directory), {
        recursive: true,
        dereference: false,
      })
    const rowsPath = join(work, 'workload.jsonl'),
      resultPath = join(work, 'workload.json')
    const trial: Record<string, unknown> = { index: 0, passed: false }
    trials.push(trial)
    const observationPath = join(work, 'native.process.json')
    const observation = await observedCommand([cold.entrypoint], {
      cwd: work,
      output: observationPath,
      timeoutMs: MANAGED_OBSERVER_MS,
      env: {
        BUNLY_CACHE_DIR: join(work, 'browser-profile'),
        BUNLY_BENCH_SANDBOX: '1',
        BUNLY_MANAGED_ROOT: project,
        BUNLY_SERVICE_RUNNER: join(paths.resources, 'backend/service-reload-runner.js'),
        BUNLY_MANAGED_ROWS: rowsPath,
        BUNLY_MANAGED_RESULT: resultPath,
        PATH: '',
      },
    }).result
    trial['observation'] = observation
    trial['observationSha256'] = hash(await readFile(observationPath))
    trial['observationContentSha256'] = managedObservationContentSha256(observation)
    trial['processResources'] = reloadObservationResources(observation)
    let rowBytes: Buffer | undefined, resultBytes: Buffer | undefined
    try {
      rowBytes = await boundedFile(rowsPath, 8 * 1024 * 1024)
    } catch {
      trial['rowsMissing'] = true
    }
    try {
      resultBytes = await boundedFile(resultPath, 2 * 1024 * 1024)
    } catch {
      trial['resultMissing'] = true
    }
    if (rowBytes) {
      trial['rowsText'] = rowBytes.toString()
      trial['rowsBytes'] = rowBytes.length
      trial['rowsSha256'] = hash(rowBytes)
    }
    if (resultBytes) {
      trial['resultText'] = resultBytes.toString()
      trial['resultBytes'] = resultBytes.length
      trial['resultSha256'] = hash(resultBytes)
    }
    try {
      assert.ok(rowBytes && resultBytes, 'Workload did not finish its fixed evidence files')
      trial['acceptance'] = acceptManagedDevelopmentWorkload(
        observation,
        rowBytes.toString(),
        resultBytes.toString()
      )
      trial['passed'] = true
    } catch (error) {
      trial['failure'] = error instanceof Error ? error.message : 'Managed workload failed'
    }
    report['restart'] = {
      attempted: false,
      passed: false,
      reason: trial['passed']
        ? 'Warm prepared-host verification has not passed; no follow-up launch admitted'
        : 'Fixed soak failed; no follow-up launch admitted',
    }
    const warmStarted = performance.now()
    const warmAttempt: Record<string, unknown> = { attempted: true, passed: false }
    cache['warm'] = warmAttempt
    try {
      const warm = await prepare()
      Object.assign(warmAttempt, {
        cacheHit: warm.cacheHit,
        durationMs: warm.durationMs,
        verifiedBytes: warm.verifiedBytes,
      })
      assert.equal(warm.cacheHit, true)
      assert.equal(warm.key, cold.key)
      assert.equal(warm.entrypoint, cold.entrypoint)
      assert.equal(assemblies, 1)
      cache['warm'] = {
        cacheHit: warm.cacheHit,
        durationMs: warm.durationMs,
        verifiedBytes: warm.verifiedBytes,
      }
    } catch (error) {
      warmAttempt['durationMs'] = performance.now() - warmStarted
      warmAttempt['failureCode'] =
        error instanceof DevelopmentError ? error.code : 'PREPARATION_FAILED'
      throw error
    } finally {
      cache['assemblies'] = assemblies
    }
    if (trial['passed']) {
      const previousResult = JSON.parse(resultBytes!.toString()) as {
        identities: { before: Record<string, string> }
      }
      const firstRenderer = rowBytes!
        .toString()
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((row) => row.kind === 'renderer') as { renderer: { instance: string } }
      report['restart'] = await runManagedRestartCheck({
        executable: cold.entrypoint,
        cwd: work,
        project,
        serviceRunner: join(paths.resources, 'backend/service-reload-runner.js'),
        previousIdentities: previousResult.identities.before,
        previousRendererInstance: firstRenderer.renderer.instance,
      })
    } else
      report['restart'] = {
        attempted: false,
        passed: false,
        reason: 'Fixed soak failed; no follow-up launch admitted',
      }
    const preparedAfter = await inventory(app)
    report['preparedArtifactAfter'] = preparedAfter
    assert.deepEqual(preparedAfter, prepared, 'Prepared host bytes changed across ordinary edits')
    const metadataAfter = await capturePreparedFileMetadata(app, prepared.entries)
    report['preparedFileMetadataAfter'] = metadataAfter
    const restart = report['restart'] as Record<string, unknown>
    report['metadataAcceptance'] = acceptPreparedFileMetadata({
      before: metadataBefore,
      after: metadataAfter,
      hostPath,
      target: `${process.platform}-${process.arch}`,
      observations: [observation, ...(restart['observation'] ? [restart['observation']] : [])],
    })
    const inputAfter = await inventory(inputRoot)
    report['inputArtifactAfter'] = inputAfter
    assert.deepEqual(inputAfter, inputInventory, 'Original selected prebuilt artifact changed')
    report['inputArtifactUnchanged'] = true
    report['preparedArtifactUnchanged'] = true
    report['preparedFileIdentityUnchanged'] = true
    report['launchPathEmpty'] = true
    report['passed'] =
      trials.length === 1 &&
      trials.every((row) => row['passed'] === true) &&
      restart['passed'] === true
  } catch (error) {
    report['failure'] = error instanceof Error ? error.message : 'Managed qualification failed'
    if (error instanceof DevelopmentError) {
      report['failureCode'] = error.code
      if (error.cacheIntegrity) report['cacheIntegrityFailure'] = error.cacheIntegrity
    }
  } finally {
    report['sourceAfter'] = sourceIdentity(root)
    report['sourceHashesAfter'] = await fingerprints().catch(() => [])
    if (
      JSON.stringify(report['sourceBefore']) !== JSON.stringify(report['sourceAfter']) ||
      JSON.stringify(report['sourceHashes']) !== JSON.stringify(report['sourceHashesAfter'])
    ) {
      report['passed'] = false
      report['failure'] = 'Qualification source changed during execution'
    }
    if (report['passed']) {
      try {
        report['acceptance'] = acceptManagedDevelopmentReport(report)
      } catch (error) {
        report['passed'] = false
        report['failure'] = error instanceof Error ? error.message : 'Final replay failed'
      }
    }
    const path = join(work, 'report.json')
    const text = JSON.stringify(report, null, 2) + '\n'
    await writeFile(path, text, { flag: 'wx', mode: 0o600 })
    await writeFile(
      join(work, 'summary.json'),
      JSON.stringify(
        {
          schema: 1,
          profile: MANAGED_PROFILE,
          passed: report['passed'],
          sourceBefore: report['sourceBefore'],
          sourceAfter: report['sourceAfter'],
          sourceHashes: report['sourceHashes'],
          nativeSource: report['nativeSource'],
          target: report['target'],
          bun: Bun.version,
          runtimeIdentity: report['runtimeIdentity'],
          inputHostSha256: report['inputHostSha256'],
          cache: report['cache'],
          cacheIntegrityFailure: report['cacheIntegrityFailure'],
          metadataAcceptance: report['metadataAcceptance'],
          restart: report['restart'] && {
            attempted: (report['restart'] as Record<string, unknown>)['attempted'],
            passed: (report['restart'] as Record<string, unknown>)['passed'],
            reason: (report['restart'] as Record<string, unknown>)['reason'],
            acceptance: (report['restart'] as Record<string, unknown>)['acceptance'],
            observationSha256: (report['restart'] as Record<string, unknown>)['observationSha256'],
            observationContentSha256: (report['restart'] as Record<string, unknown>)[
              'observationContentSha256'
            ],
            resultSha256: (report['restart'] as Record<string, unknown>)['resultSha256'],
            failure: (report['restart'] as Record<string, unknown>)['failure'],
          },
          trials: trials.map((trial) => ({
            index: trial['index'],
            passed: trial['passed'],
            rowsSha256: trial['rowsSha256'],
            resultSha256: trial['resultSha256'],
            observationSha256: trial['observationSha256'],
            observationContentSha256: trial['observationContentSha256'],
            acceptance: trial['acceptance'],
            failure: trial['failure'],
          })),
          acceptance: report['acceptance'],
          reportSha256: hash(text),
          performanceEligible: false,
          limitations: report['limitations'],
          failure: report['failure'],
          failureCode: report['failureCode'],
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
    console.log(
      JSON.stringify({ passed: report['passed'], output: path, failure: report['failure'] })
    )
  }
  if (!report['passed']) process.exitCode = 1
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === '--verify') {
    assert.equal(args.length, 2)
    await verify(args[1]!)
  } else await qualify(args)
}
