/** Fixed native M7 workload against an explicitly selected immutable prebuilt host. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import {
  observedCommand,
  assertCleanCommand,
  type CommandObservation,
} from '../benchmarks/lib/observed-command.ts'
import { cefIdentityFromObservation } from '../benchmarks/lib/cef-identity.ts'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'
import {
  capturePreparedFileMetadata,
  acceptPreparedFileMetadata,
} from '../benchmarks/reload/prepared-file-metadata.ts'
import { DESKTOP_OBSERVER_MS } from '../benchmarks/desktop/acceptance.ts'
import { desktopProfile, desktopReportProfile } from '../benchmarks/desktop/profiles.ts'
import { summarizeDesktopFailures } from '../benchmarks/desktop/failure-codes.ts'
import { prepareManagedRuntimeLayout } from './qualify-managed-development.ts'
import { requireDisposableClipboardRunner } from './cef-desktop-services-precondition.ts'
import {
  applicationLinkManifest,
  applicationLinkStartupInputs,
} from '../examples/application-links/contract.ts'

const root = resolve(import.meta.dir, '..')
const mac = process.platform === 'darwin'
const hash = (input: Uint8Array | string) => createHash('sha256').update(input).digest('hex')
function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(result.exitCode, 0, 'Required local Git source object is missing')
  return result.stdout.toString().trim()
}
async function verify(filename: string): Promise<void> {
  const path = resolve(filename)
  const info = await lstat(path)
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 32 * 1024 * 1024
  )
  const bytes = await readFile(path)
  assert.equal(bytes.length, info.size)
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<
    string,
    unknown
  >
  const report = Object.hasOwn(parsed, 'nativeEvidenceExport')
    ? decodeExportedNativeReport(parsed)
    : parsed
  const profile = desktopReportProfile(report['profile'])
  const acceptance = profile.acceptReport(report)
  const source = report['sourceBefore'] as { commit: string }
  const entries = report['sourceHashes'] as { path: string; sha256: string }[]
  const expected = git(
    'ls-tree',
    '-r',
    '--name-only',
    source.commit,
    '--',
    ...profile.sourceSelectors
  )
    .split('\n')
    .filter(Boolean)
  assert.deepEqual(
    entries.map((entry) => entry.path),
    expected,
    'Incomplete historical source inventory'
  )
  for (const entry of entries) {
    const blob = Bun.spawnSync(['git', 'show', `${source.commit}:${entry.path}`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    assert.equal(blob.exitCode, 0, 'Historical source missing; no implicit fetch')
    assert.equal(hash(blob.stdout), entry.sha256, entry.path)
  }
  const native = report['nativeSource'] as { declaredCommit: string; tree: string }
  assert.ok(/^[a-f0-9]{40}$/.test(native.declaredCommit))
  assert.equal(git('rev-parse', `${native.declaredCommit}:native/cef-host`), native.tree)
  assert.equal(git('rev-parse', `${source.commit}:native/cef-host`), native.tree)
  console.log(
    JSON.stringify({
      profile: profile.profile + '-retained-replay',
      source: source.commit,
      reportSha256: hash(bytes),
      acceptance,
    })
  )
}

async function qualify(input: readonly string[]): Promise<void> {
  assert.equal(Bun.version, '1.4.4', 'Use pinned Bun 1.4.4')
  const args = [...input]
  const flag = args.findIndex((argument) => argument.startsWith('--case='))
  const profile = desktopProfile(flag < 0 ? 'windows' : args.splice(flag, 1)[0]!.slice(7))
  const clipboardFlag = args.indexOf('--disposable-clipboard')
  const clipboardOptIn = clipboardFlag < 0 ? undefined : args.splice(clipboardFlag, 1)[0]
  assert.equal(
    args.length,
    2,
    'Use qualify-desktop PREPARED_APP --native-source=COMMIT [--case=windows|composition|composition-profile|composition-interactions|services|downloads|commands|dialogs|status|links|parent-close] [--disposable-clipboard], or --verify REPORT'
  )
  const selected = /^--native-source=([a-f0-9]{40})$/.exec(args[1]!)?.[1]
  assert.ok(selected, 'Explicit immutable native build source required')
  const target = `${process.platform}-${process.arch}`
  assert.ok(['darwin-arm64', 'linux-x64', 'win32-x64'].includes(target))
  assert.ok(process.platform === 'win32' || process.getuid?.() !== 0, 'Use a standard user')
  // This contributor precondition is checked before copying, signing or launching
  // any native application. It is independent of runtime clipboard authority.
  const services = profile.directory === 'desktop-services'
  assert.ok(clipboardOptIn === undefined || services, 'Clipboard opt-in requires --case=services')
  let clipboardLaunch: Record<string, unknown> | undefined
  if (services) {
    if (target === 'linux-x64') {
      assert.equal(clipboardOptIn, undefined, 'Linux clipboard execution is unsupported')
      clipboardLaunch = { mode: 'unsupported', target }
    } else {
      requireDisposableClipboardRunner({
        optIn: clipboardOptIn,
        platform: process.platform,
        arch: process.arch,
        environment: process.env,
      })
      clipboardLaunch = {
        mode: 'disposable-github-hosted',
        target,
        explicitOptIn: true,
        runId: process.env['GITHUB_RUN_ID'],
      }
    }
  }
  const before = sourceIdentity(root)
  assert.equal(before.clean, true, 'Qualification requires clean committed source')
  assert.ok(before.commit)
  const nativeTree = git('rev-parse', `${selected}:native/cef-host`)
  assert.equal(
    nativeTree,
    git('rev-parse', `${before.commit}:native/cef-host`),
    'Prebuilt native source mismatch'
  )
  const paths = git('ls-tree', '-r', '--name-only', before.commit, '--', ...profile.sourceSelectors)
    .split('\n')
    .filter(Boolean)
  const fingerprints = () =>
    Promise.all(
      paths.map(async (path) => ({ path, sha256: hash(await readFile(join(root, path))) }))
    )
  const source = resolve(args[0]!)
  const inputRoot = mac ? source : dirname(source)
  const inputArtifact = await inventory(inputRoot)
  const parent = join(root, '.bunly/m7', profile.directory)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const work = await mkdtemp(join(parent, 'run-'))
  const report: Record<string, unknown> = {
    schema: 1,
    profile: profile.profile,
    passed: false,
    target,
    bun: Bun.version,
    observerTimeoutMs: DESKTOP_OBSERVER_MS,
    sourceBefore: before,
    sourceHashes: await fingerprints(),
    nativeSource: { declaredCommit: selected, tree: nativeTree, embeddedBuildAttestation: false },
    inputArtifact,
    performanceEligible: false,
    ...(clipboardLaunch === undefined ? {} : { clipboardLaunch }),
    limitations: [
      profile.workloadLimitation,
      'No physical keyboard, IME, assistive technology, multi-monitor or hardware DPI qualification.',
      'Selected prebuilt source is declared and its bytes inventoried; no embedded build attestation.',
    ],
  }
  const python = process.env['PYTHON'] ?? 'python3'
  let observation: CommandObservation | undefined
  try {
    const app = join(work, profile.title + (mac ? '.app' : ' Unicode é Ω'))
    await cp(inputRoot, app, { recursive: true, dereference: false })
    await prepareManagedRuntimeLayout(app)
    const resources = join(app, mac ? 'Contents/Resources' : 'resources')
    const runtime = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')) as Record<
      string,
      unknown
    >
    assert.equal(runtime['development_origin'], undefined)
    assert.equal(runtime['bun_version'], '1.4.4')
    assert.equal(runtime['cef_version'], '156.0.7')
    if (profile.directory === 'application-links') {
      assert.equal(
        runtime['application_links'],
        undefined,
        'Base artifact already declares application link routes'
      )
      runtime['application_links'] = applicationLinkManifest
      await writeFile(join(resources, 'runtime.json'), JSON.stringify(runtime) + '\n')
    }
    const backend = join(resources, 'backend')
    await rm(backend, { recursive: true, force: true })
    await mkdir(backend)
    for (const [entry, name] of [
      ['scripts/cef-bootstrap.ts', 'main.js'],
      [
        'applicationEntry' in profile ? profile.applicationEntry : profile.fixture + '/fixture.ts',
        'application.js',
      ],
    ] as const) {
      const built = await Bun.build({
        entrypoints: [join(root, entry)],
        outdir: backend,
        naming: name,
        target: 'bun',
        format: 'esm',
        sourcemap: 'linked',
        minify: false,
      })
      assert.equal(built.success, true, built.logs.join('\n'))
    }
    const publicRoot = join(resources, 'public')
    await rm(publicRoot, { recursive: true, force: true })
    await cp(join(root, profile.fixture, 'public'), publicRoot, {
      recursive: true,
      dereference: false,
    })
    if (profile.browserEntry !== null) {
      const browser = await Bun.build({
        entrypoints: [join(root, profile.browserEntry)],
        outdir: publicRoot,
        naming: 'client.js',
        target: 'browser',
        format: 'esm',
        minify: false,
      })
      assert.equal(browser.success, true, browser.logs.join('\n'))
    }
    const assets: Record<string, { bytes: number; sha256: string }> = {}
    for (const entry of (await inventory(publicRoot)).entries) {
      assert.equal(entry.kind, 'file')
      assert.ok(entry.sha256)
      assets[entry.path] = { bytes: entry.bytes, sha256: entry.sha256 }
    }
    await writeFile(join(publicRoot, 'assets.json'), JSON.stringify(assets, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
    report['assets'] = assets
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
        { flag: 'wx', mode: 0o600 }
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
    const metadata = await capturePreparedFileMetadata(app, prepared.entries)
    report['preparedArtifact'] = prepared
    report['preparedMetadataBefore'] = metadata
    const hostPath = mac
      ? 'Contents/MacOS/bunly_host'
      : process.platform === 'win32'
        ? 'bunly_host.exe'
        : 'bunly_host'
    report['hostPath'] = hostPath
    report['inputHostSha256'] = inputArtifact.entries.find(
      (entry) => entry.path === hostPath
    )?.sha256
    report['preparedHostSha256'] = prepared.entries.find((entry) => entry.path === hostPath)?.sha256
    const bunPath = mac
      ? 'Contents/Resources/bun'
      : process.platform === 'win32'
        ? 'resources/bun.exe'
        : 'resources/bun'
    const bunObservation = await observedCommand([join(app, bunPath), '--version'], {
      cwd: work,
      output: join(work, 'bun.process.json'),
      timeoutMs: 30_000,
      env: { PATH: '' },
    }).result
    assertCleanCommand(bunObservation)
    assert.deepEqual(bunObservation.stdoutTail, ['1.4.4'])
    report['bundledBun'] = {
      version: '1.4.4',
      path: bunPath,
      sha256: prepared.entries.find((entry) => entry.path === bunPath)?.sha256,
      observation: bunObservation,
    }
    const libraryPath = mac
      ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
      : process.platform === 'win32'
        ? 'libcef.dll'
        : 'libcef.so'
    // Reuse the streamed inventory digest rather than materializing a second copy of CEF in RAM.
    const libraryHash = prepared.entries.find((entry) => entry.path === libraryPath)?.sha256
    assert.ok(libraryHash)
    const identity = await observedCommand(
      [
        python,
        join(root, 'scripts/probe_cef_identity.py'),
        '--library',
        join(app, libraryPath),
        '--sha256',
        libraryHash,
      ],
      { cwd: work, output: join(work, 'identity.process.json'), timeoutMs: 30_000 }
    ).result
    assertCleanCommand(identity)
    report['identityObservation'] = identity
    report['runtimeIdentity'] = cefIdentityFromObservation(identity, libraryHash)
    const executable = mac ? join(app, 'Contents/MacOS/bunly_host') : join(app, basename(source))
    assert.equal(relative(app, executable).split('\\').join('/'), hostPath)
    observation = await observedCommand(
      [
        executable,
        ...(profile.directory === 'application-links'
          ? applicationLinkStartupInputs.map((url) => '--bunly-link=' + url)
          : []),
      ],
      {
        cwd: work,
        output: join(work, 'trial.process.json'),
        timeoutMs: DESKTOP_OBSERVER_MS,
        env: { BUNLY_CACHE_DIR: join(work, 'cache'), BUNLY_BENCH_SANDBOX: '1' },
      }
    ).result
    report['observation'] = observation
    report['acceptance'] = profile.acceptObservation(observation)
    report['preparedArtifactAfter'] = await inventory(app)
    assert.deepEqual(report['preparedArtifactAfter'], prepared)
    const metadataAfter = await capturePreparedFileMetadata(app, prepared.entries)
    report['preparedMetadataAfter'] = metadataAfter
    report['preparedMetadata'] = acceptPreparedFileMetadata({
      before: metadata,
      after: metadataAfter,
      target,
      hostPath,
      observations: [observation],
    })
    report['inputArtifactAfter'] = await inventory(inputRoot)
    assert.deepEqual(report['inputArtifactAfter'], inputArtifact)
    report['preparedArtifactUnchanged'] = true
    report['inputArtifactUnchanged'] = true
    report['passed'] = true
  } catch (error) {
    report['failure'] = error instanceof Error ? error.message : String(error)
  } finally {
    report['sourceAfter'] = sourceIdentity(root)
    report['sourceHashesAfter'] = await fingerprints().catch((error) => ({
      failure: String(error),
    }))
    if (
      JSON.stringify(report['sourceBefore']) !== JSON.stringify(report['sourceAfter']) ||
      JSON.stringify(report['sourceHashes']) !== JSON.stringify(report['sourceHashesAfter'])
    ) {
      report['passed'] = false
      report['failure'] = 'Qualifier sources changed during execution'
    }
    if (report['passed']) {
      try {
        profile.acceptReport(report)
      } catch (error) {
        report['passed'] = false
        report['failure'] = String(error)
      }
    }
    const output = join(work, 'report.json')
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(
      JSON.stringify({
        passed: report['passed'] === true,
        output,
        failure: report['passed'] === true ? null : 'qualification-failed',
        diagnostics: summarizeDesktopFailures(profile.profile, observation),
      })
    )
  }
  if (!report['passed']) process.exitCode = 1
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === '--verify' && args.length === 2) await verify(args[1]!)
  else await qualify(args)
}
