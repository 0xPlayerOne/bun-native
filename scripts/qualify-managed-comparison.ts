/** Current common-outcome comparison. Explicit smoke cohorts; never a relative-speed claim. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpus, release, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'
import { runComparisonAdapter } from '../benchmarks/reload/managed-comparison-adapters.ts'
import { acceptManagedComparisonReport } from '../benchmarks/reload/managed-comparison-report.ts'
import {
  COMPARISON_PLAN,
  MANAGED_COMPARISON_PROFILE,
} from '../benchmarks/reload/managed-comparison.ts'

const root = resolve(import.meta.dir, '..')
const sourceSelectors = [
  'package.json',
  'bun.lock',
  'packages/runtime/src',
  'packages/cli/src',
  'packages/contracts/src',
  'benchmarks/fixtures',
  'benchmarks/lib',
  'benchmarks/reload',
  'benchmarks/foundation',
  'benchmarks/adapters',
  'scripts',
  'native/cef-host',
]
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const git = (...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  assert.equal(result.exitCode, 0, 'Required local source object unavailable')
  return result.stdout.toString().trim()
}
async function verify(path: string) {
  const stat = await lstat(path)
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 64 * 1024 * 1024
  )
  const bytes = await readFile(path)
  const parsed = JSON.parse(bytes.toString()) as Record<string, unknown>
  const report = Object.hasOwn(parsed, 'nativeEvidenceExport')
    ? decodeExportedNativeReport(parsed)
    : parsed
  const acceptance = acceptManagedComparisonReport(report)
  const commit = (report['sourceBefore'] as { commit: string }).commit
  const hashes = report['sourceHashes'] as { path: string; sha256: string }[]
  const paths = git('ls-tree', '-r', '--name-only', commit, '--', ...sourceSelectors)
    .split('\n')
    .filter(Boolean)
  assert.deepEqual(hashes.map((row) => row.path).sort(), paths.sort())
  for (const row of hashes) {
    const blob = Bun.spawnSync(['git', 'show', `${commit}:${row.path}`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    })
    assert.equal(blob.exitCode, 0)
    assert.equal(hash(blob.stdout), row.sha256, row.path)
  }
  const native = report['nativeSource'] as { declaredCommit: string; tree: string }
  assert.equal(git('rev-parse', `${native.declaredCommit}:native/cef-host`), native.tree)
  assert.equal(git('rev-parse', `${commit}:native/cef-host`), native.tree)
  console.log(
    JSON.stringify({
      profile: MANAGED_COMPARISON_PROFILE + '-retained-replay',
      reportSha256: hash(bytes),
      acceptance,
    })
  )
}
async function qualify(args: readonly string[]) {
  assert.equal(
    args.length,
    4,
    'Use PREBUILT_APP --native-source=COMMIT --reference-root=INSTALLED_REPOSITORY --mirin-lock=SHA256, or --verify REPORT'
  )
  assert.equal(Bun.version, '1.4.3')
  assert.ok(process.getuid?.() !== 0, 'Native comparison requires a standard user')
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'arm64')
  const prebuilt = resolve(args[0]!)
  const nativeSource = /^--native-source=([a-f0-9]{40})$/.exec(args[1]!)?.[1]
  const referenceRoot = /^--reference-root=(.+)$/.exec(args[2]!)?.[1]
  const mirinLock = /^--mirin-lock=([a-f0-9]{64})$/.exec(args[3]!)?.[1]
  assert.ok(nativeSource && referenceRoot && mirinLock)
  const before = sourceIdentity(root)
  assert.ok(
    before.clean && before.commit,
    'Commit comparison implementation before native execution'
  )
  const nativeTree = git('rev-parse', `${nativeSource}:native/cef-host`)
  assert.equal(nativeTree, git('rev-parse', `${before.commit}:native/cef-host`))
  const paths = git('ls-tree', '-r', '--name-only', before.commit, '--', ...sourceSelectors)
    .split('\n')
    .filter(Boolean)
  const fingerprints = () =>
    Promise.all(
      paths.map(async (path) => ({ path, sha256: hash(await readFile(join(root, path))) }))
    )
  const parent = join(root, '.bunly/m6/managed-comparison')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const work = await mkdtemp(join(parent, 'run-'))
  const report: Record<string, unknown> = {
    schema: 1,
    profile: MANAGED_COMPARISON_PROFILE,
    plan: COMPARISON_PLAN,
    passed: false,
    target: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    sourceBefore: before,
    sourceHashes: await fingerprints(),
    nativeSource: {
      declaredCommit: nativeSource,
      tree: nativeTree,
      limitation:
        'Caller-declared native source and matching tree; no embedded source attestation in prebuilt input.',
    },
    environment: {
      os: release(),
      cpu: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      power: 'uncontrolled',
      display: 'uncontrolled',
      gpu: 'unrecorded',
    },
    performanceEligible: false,
    runClass: 'local-smoke',
    frameworks: [],
    limitations: [
      'Same selected user outcome and renderer assets, different lifecycle: Bunly retains its native host/document; references officially rebuild/relaunch and restore browser-owned form/transcript from localStorage.',
      'Numbered output is a deterministic bounded synthetic workbench transcript rendered by xterm 5.5.0, not a retained native PTY or surviving external shell. The separate native500 qualification covers Bunly PTY continuity.',
      'One initial launch, one excluded warmup edit and three correlated measured edits per framework; every row must pass and no failed warmup is discarded.',
      'Per-framework runtime and exported CEF identity are recorded separately. Browser process sandbox remains unverified for this profile. Different engine/security cohorts, fixed order and uncontrolled hardware prevent relative performance claims.',
      'Edit timing includes source write, official reference stop/build/relaunch or Bunly bundle/Worker transaction, common renderer polling, transcript verification, xterm callback and two animation frames; no physical input-to-photon claim.',
      'Installed reference pins and file/lock hashes are checked without authenticating registry provenance. Setup copies are excluded; native compilation is never invoked for Bunly.',
    ],
  }
  const frameworks = report['frameworks'] as Awaited<ReturnType<typeof runComparisonAdapter>>[]
  try {
    for (const framework of ['bunly', 'electrobun', 'mirin'] as const) {
      const result = await runComparisonAdapter(framework, {
        prebuilt,
        referenceRoot,
        mirinLock,
        output: join(work, framework),
      })
      frameworks.push(result)
      console.log(JSON.stringify({ framework, passed: result.passed, failure: result.failure }))
    }
    report['passed'] = frameworks.every((row) => row.passed)
  } catch (error) {
    report['failure'] = error instanceof Error ? error.message : 'Comparison failed'
  } finally {
    report['sourceAfter'] = sourceIdentity(root)
    report['sourceHashesAfter'] = await fingerprints()
    if (
      JSON.stringify(report['sourceBefore']) !== JSON.stringify(report['sourceAfter']) ||
      JSON.stringify(report['sourceHashes']) !== JSON.stringify(report['sourceHashesAfter'])
    ) {
      report['passed'] = false
      report['failure'] = 'Comparison source changed during execution'
    }
    if (report['passed']) {
      try {
        report['acceptance'] = acceptManagedComparisonReport(report)
      } catch (error) {
        report['passed'] = false
        report['failure'] = error instanceof Error ? error.message : 'Comparison replay failed'
      }
    }
    const path = join(work, 'report.json'),
      text = JSON.stringify(report, null, 2) + '\n'
    await writeFile(path, text, { flag: 'wx', mode: 0o600 })
    await writeFile(
      join(work, 'summary.json'),
      JSON.stringify(
        {
          schema: 1,
          profile: MANAGED_COMPARISON_PROFILE,
          passed: report['passed'],
          plan: COMPARISON_PLAN,
          sourceBefore: before,
          sourceAfter: report['sourceAfter'],
          sourceHashes: report['sourceHashes'],
          nativeSource: report['nativeSource'],
          target: report['target'],
          frameworks: frameworks.map((item) => ({
            framework: item.framework,
            passed: item.passed,
            engine: item.engine,
            runtimeVersion: item.rows[0]?.observation?.host.runtimeVersion ?? null,
            processSandbox: item.processSandbox,
            acceptance: item.acceptance,
            rows: item.rows,
            failure: item.failure,
          })),
          performanceEligible: false,
          acceptance: report['acceptance'],
          reportSha256: hash(text),
          limitations: report['limitations'],
          failure: report['failure'],
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
    await verify(resolve(args[1]!))
  } else await qualify(args)
}
