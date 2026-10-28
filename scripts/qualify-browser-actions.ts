/** Four actual process profiles. Native compilation is an explicit prior contributor step. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import { nativeEvents } from '../benchmarks/lib/cef-acceptance.ts'
import { cefIdentityFromObservation } from '../benchmarks/lib/cef-identity.ts'
import { prepareManagedRuntimeLayout } from './qualify-managed-development.ts'

const root = resolve(import.meta.dir, '..')
const mac = process.platform === 'darwin'
const profiles = ['enabled', 'feature-disabled', 'ordinary', 'manifest-denied'] as const
const requiredChecks = [
  'ungrantedDenied',
  'png',
  'approvedEvaluation',
  'boundedObservations',
  'syntheticInput',
  'beforeinputRevalidated',
  'crossOriginFrameDenied',
  'oversizedResultsDenied',
  'otherSessionDenied',
  'cancellationSettled',
  'navigationRevoked',
  'closeSettled',
  'zeroOwners',
] as const
export function acceptBrowserActionReceipt(input: unknown): void {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input))
  const value = input as Record<string, unknown>
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024)
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'event',
      'schema',
      'passed',
      'failure',
      'workloadMs',
      'checks',
      'screenshot',
      'accessibility',
      'nativeSettled',
      'final',
      'syntheticInput',
      'trustedInputQualified',
      'performanceEligible',
    ].sort()
  )
  assert.equal(value['event'], 'bunly.native.browser-actions')
  assert.equal(value['schema'], 1)
  assert.equal(value['passed'], true)
  assert.equal(value['failure'], null)
  assert.equal(value['syntheticInput'], true)
  assert.equal(value['trustedInputQualified'], false)
  assert.equal(value['performanceEligible'], false)
  assert.ok(
    typeof value['workloadMs'] === 'number' &&
      value['workloadMs'] > 0 &&
      value['workloadMs'] < 45_000
  )
  assert.deepEqual(value['checks'], Object.fromEntries(requiredChecks.map((key) => [key, true])))
  assert.ok(value['accessibility'] === 'supported' || value['accessibility'] === 'unsupported')
  const screenshot = value['screenshot'] as Record<string, unknown>
  assert.deepEqual(Object.keys(screenshot).sort(), ['bytes', 'width', 'height', 'sha256'].sort())
  assert.ok(
    Number.isInteger(screenshot['bytes']) &&
      Number(screenshot['bytes']) > 57 &&
      Number(screenshot['bytes']) <= 1024 * 1024
  )
  assert.ok(
    Number.isInteger(screenshot['width']) &&
      Number(screenshot['width']) > 0 &&
      Number(screenshot['width']) <= 128
  )
  assert.ok(
    Number.isInteger(screenshot['height']) &&
      Number(screenshot['height']) > 0 &&
      Number(screenshot['height']) <= 96
  )
  assert.match(String(screenshot['sha256']), /^[a-f0-9]{64}$/)
  const native = value['nativeSettled'] as Record<string, unknown>
  assert.deepEqual(
    Object.keys(native).sort(),
    [
      'operations',
      'registrations',
      'callbacks',
      'byteLeases',
      'ownedBytes',
      'reservedBytes',
      'deadlineWorkers',
      'admitted',
      'completed',
      'failed',
    ].sort()
  )
  for (const key of ['admitted', 'completed', 'failed'])
    assert.ok(Number.isSafeInteger(native[key]) && Number(native[key]) > 0)
  assert.equal(native['admitted'], Number(native['completed']) + Number(native['failed']))
  for (const key of [
    'operations',
    'registrations',
    'callbacks',
    'byteLeases',
    'ownedBytes',
    'reservedBytes',
    'deadlineWorkers',
  ])
    assert.equal(native[key], 0)
  const final = value['final'] as Record<string, unknown>
  for (const key of ['views', 'windows', 'sessions', 'listeners', 'listenerErrors'])
    assert.equal(final[key], 0)
}
function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(result.exitCode, 0, 'Required immutable source object unavailable')
  return result.stdout.toString().trim()
}
async function qualify(args: readonly string[]): Promise<void> {
  assert.equal(
    args.length,
    3,
    'Use qualify-browser-actions ORDINARY_APP_DIRECTORY FEATURE_APP_DIRECTORY --native-source=COMMIT'
  )
  assert.equal(Bun.version, '1.4.3')
  assert.ok(
    process.platform === 'win32' || process.getuid?.() !== 0,
    'Actual CEF qualification requires a standard user'
  )
  const declared = /^--native-source=([a-f0-9]{40})$/.exec(args[2]!)?.[1]
  assert.ok(declared)
  const sourceBefore = sourceIdentity(root)
  assert.equal(sourceBefore.clean, true, 'Commit the source before native qualification')
  assert.ok(sourceBefore.commit)
  const nativeTree = git('rev-parse', `${declared}:native/cef-host`)
  assert.equal(nativeTree, git('rev-parse', `${sourceBefore.commit}:native/cef-host`))
  const sourcePaths = git(
    'ls-tree',
    '-r',
    '--name-only',
    sourceBefore.commit,
    '--',
    'native/cef-host',
    'packages/contracts',
    'packages/runtime',
    'examples/browser-actions',
    'examples/file-downloads/readiness.ts',
    'scripts/cef-bootstrap.ts',
    'scripts/qualify-browser-actions.ts',
    'scripts/observe-process.py',
    'scripts/probe_cef_identity.py',
    'scripts/qualify_adhoc_signing.py',
    'scripts/qualify-managed-development.ts',
    'benchmarks/lib'
  )
    .split('\n')
    .filter(Boolean)
  const fingerprints = () =>
    Promise.all(
      sourcePaths.map(async (path) => ({
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      }))
    )
  const parent = join(root, '.bunly/m7/browser-actions')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const work = await mkdtemp(join(parent, 'run-'))
  const input = { ordinary: resolve(args[0]!), feature: resolve(args[1]!) }
  assert.notEqual(
    input.ordinary,
    input.feature,
    'Keep ordinary and feature build artifacts separate'
  )
  const inputBefore = {
    ordinary: await inventory(input.ordinary),
    feature: await inventory(input.feature),
  }
  const report: Record<string, unknown> = {
    schema: 1,
    profile: 'native-browser-actions-v1',
    passed: false,
    target: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    sourceBefore,
    sourceHashes: await fingerprints(),
    nativeSource: { declaredCommit: declared, tree: nativeTree, embeddedBuildAttestation: false },
    inputBefore,
    trials: [],
    performanceEligible: false,
    limitations: [
      'Synthetic DOM input only; trusted/hardware input is unsupported.',
      'Functional actual CEF evidence; no physical input, assistive technology or performance claim.',
      'CEF-owned renderer/callback storage is outside the separately bounded Bunly byte-owner budget.',
    ],
  }
  const python = process.env['PYTHON'] ?? 'python3'
  const output = join(work, 'report.json')
  try {
    const library = mac
      ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
      : process.platform === 'win32'
        ? 'libcef.dll'
        : 'libcef.so'
    const identities: Record<string, unknown> = {}
    for (const kind of ['ordinary', 'feature'] as const) {
      const digest = inputBefore[kind].entries.find((entry) => entry.path === library)?.sha256
      assert.ok(digest)
      const observation = await observedCommand(
        [
          python,
          join(root, 'scripts/probe_cef_identity.py'),
          '--library',
          join(input[kind], library),
          '--sha256',
          digest,
        ],
        { cwd: work, output: join(work, `${kind}-identity.process.json`), timeoutMs: 30_000 }
      ).result
      assertCleanCommand(observation)
      identities[kind] = cefIdentityFromObservation(observation, digest)
    }
    report['runtimeIdentities'] = identities
    for (const profile of profiles) {
      const app = join(work, profile + (mac ? '.app' : ''))
      const selected = profile === 'feature-disabled' ? input.ordinary : input.feature
      await cp(selected, app, { recursive: true, dereference: false })
      await prepareManagedRuntimeLayout(app)
      const resources = join(app, mac ? 'Contents/Resources' : 'resources')
      const runtime = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')) as Record<
        string,
        unknown
      >
      assert.equal(runtime['bun_version'], '1.4.3')
      assert.equal(runtime['cef_version'], '156.0.7')
      delete runtime['development_origin']
      if (profile !== 'ordinary') runtime['development_origin'] = 'http://127.0.0.1:54381'
      runtime['development_browser_actions'] = profile !== 'manifest-denied'
      await writeFile(join(resources, 'runtime.json'), JSON.stringify(runtime) + '\n')
      const backend = join(resources, 'backend')
      await rm(backend, { recursive: true, force: true })
      await mkdir(backend)
      for (const [entry, name] of [
        ['scripts/cef-bootstrap.ts', 'main.js'],
        ['examples/browser-actions/fixture.ts', 'application.js'],
      ] as const) {
        const result = await Bun.build({
          entrypoints: [join(root, entry)],
          outdir: backend,
          naming: name,
          target: 'bun',
          format: 'esm',
          sourcemap: 'linked',
          minify: false,
        })
        assert.equal(result.success, true, result.logs.join('\n'))
      }
      const publicRoot = join(resources, 'public')
      await rm(publicRoot, { recursive: true, force: true })
      await mkdir(publicRoot)
      const html = '<!doctype html><title>Browser action fixture resources</title>'
      await writeFile(join(publicRoot, 'index.html'), html)
      await writeFile(
        join(publicRoot, 'assets.json'),
        JSON.stringify({
          'index.html': {
            bytes: Buffer.byteLength(html),
            sha256: createHash('sha256').update(html).digest('hex'),
          },
        }) + '\n'
      )
      if (mac) {
        const code =
          'import sys,subprocess\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom qualify_adhoc_signing import targets\nfor p in targets(Path(sys.argv[2])): subprocess.run(["/usr/bin/codesign","--force","--sign","-",str(p)],check=True,capture_output=True)\n'
        const signed = await observedCommand([python, '-c', code, join(root, 'scripts'), app], {
          cwd: work,
          output: join(work, `${profile}-sign.process.json`),
          timeoutMs: 30_000,
        }).result
        assertCleanCommand(signed)
      }
      const preparedBefore = await inventory(app)
      const host = join(
        app,
        mac
          ? 'Contents/MacOS/bunly_host'
          : process.platform === 'win32'
            ? 'bunly_host.exe'
            : 'bunly_host'
      )
      const observation = await observedCommand([host], {
        cwd: work,
        output: join(work, `${profile}.process.json`),
        timeoutMs: 60_000,
        env: { BUNLY_CACHE_DIR: join(work, `${profile}-cache`), BUNLY_BENCH_SANDBOX: '1' },
      }).result
      const trial: Record<string, unknown> = { profile, observation, preparedBefore }
      ;(report['trials'] as unknown[]).push(trial)
      assertCleanCommand(observation, profile === 'enabled' ? 0 : 78)
      const events = nativeEvents(observation)
      const receipts = events.filter((event) => event['event'] === 'bunly.native.browser-actions')
      if (profile === 'enabled') {
        assert.equal(receipts.length, 1)
        acceptBrowserActionReceipt(receipts[0])
      } else {
        assert.equal(receipts.length, 0)
        const errors = events.filter((event) => event['event'] === 'bunly.host.error')
        assert.equal(errors.length, 1)
        assert.equal(
          errors[0]!['error'],
          profile === 'feature-disabled'
            ? 'browser-actions is unavailable in this native build'
            : 'browser-actions requires an explicit development manifest opt-in'
        )
      }
      trial['preparedAfter'] = await inventory(app)
      assert.deepEqual(trial['preparedAfter'], preparedBefore)
      trial['passed'] = true
    }
    report['inputAfter'] = {
      ordinary: await inventory(input.ordinary),
      feature: await inventory(input.feature),
    }
    assert.deepEqual(report['inputAfter'], inputBefore)
    report['passed'] = true
  } catch (error) {
    report['failure'] = error instanceof Error ? error.message : String(error)
  } finally {
    report['sourceAfter'] = sourceIdentity(root)
    report['sourceHashesAfter'] = await fingerprints()
    try {
      assert.deepEqual(report['sourceAfter'], sourceBefore)
      assert.deepEqual(report['sourceHashesAfter'], report['sourceHashes'])
    } catch {
      report['passed'] = false
      report['failure'] ??= 'Source changed during qualification'
    }
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ profile: report['profile'], passed: report['passed'], output }))
  }
  if (report['passed'] !== true)
    throw new Error(`Browser actions qualification failed; retained ${output}`)
}
if (import.meta.main) await qualify(process.argv.slice(2))
