import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { phaseSummary, type ObservationSample } from '../benchmarks/lib/observation.ts'
import { nativeHostArtifacts } from './cargo-artifacts.ts'
const root = resolve(import.meta.dir, '..')
const out = join(root, '.bunly/qualification')
await mkdir(out, { recursive: true })
const target = `${process.platform}-${process.arch}`
const python = process.env['PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3')
const native = nativeHostArtifacts(root)
const addon = join(out, 'probe.node')
await copyFile(native.library, addon)
const results: Record<string, unknown>[] = []
async function observe(name: string, command: string[], expectedCrash = false): Promise<void> {
  const file = join(out, `lifecycle-${target}-${name}.json`)
  try {
    const proc = Bun.spawn(
      [
        python,
        join(root, 'scripts/observe-process.py'),
        '--output',
        file,
        '--timeout',
        '35',
        '--',
        ...command,
      ],
      { stdout: 'inherit', stderr: 'inherit' }
    )
    const code = await proc.exited
    const report = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const reports = report['reports'] as Record<string, unknown>[]
    const passed =
      code === 0 &&
      (expectedCrash
        ? report['exitCode'] !== 0
        : report['exitCode'] === 0 && reports.at(-1)?.['passed'] === true)
    if (!passed)
      console.error(
        JSON.stringify({
          name,
          exitCode: report['exitCode'],
          stderr: report['stderr'],
          reportCount: reports.length,
        })
      )
    results.push({
      name,
      passed,
      expectedCrash,
      report: basename(file),
      observedProcesses: report['observedProcesses'],
      peakTreeRssBytes: report['peakTreeRssBytes'],
      peakTreeThreads: report['peakTreeThreads'],
      generations: reports.at(-1)?.['generations'] ?? null,
      phases: phaseSummary(report['samples'] as ObservationSample[]),
    })
  } catch (error) {
    results.push({ name, passed: false, error: String(error) })
    console.error(`Qualification ${name}: ${String(error)}`)
  }
}
for (const mode of ['ffi', 'napi'] as const) {
  for (const scenario of ['normal', 'hang'])
    await observe(`${mode}-${scenario}`, [
      process.execPath,
      join(root, 'scripts/probes/recreate.ts'),
      mode,
      addon,
      scenario,
    ])
}
const executable = native.processSoak
await observe('process-soak', [
  executable,
  process.execPath,
  join(root, 'scripts/probes/process-generation.ts'),
])
await observe('native-crash', [executable, '--crash-fixture'], true)
const summary = {
  schema: 1,
  target,
  bun: Bun.version,
  commit: process.env['GITHUB_SHA'] ?? 'local',
  scope: 'ABI lifecycle qualification, not GUI performance',
  results,
  passed: results.every((result) => result['passed'] === true),
  limitations: [
    'Kernel wakeups require separate platform instrumentation and remain unavailable here.',
    'Equivalent 200ms idle + 256 ordered operations + GC cadence; process transport and extra fault cases are disclosed, not hidden.',
    'Forced callback-owner termination is tested only after the native loop returns and dispatch is revoked.',
    'A native process abort demonstrates failure containment of the observation harness, not crash recovery inside one address space.',
  ],
}
await writeFile(
  join(out, `lifecycle-summary-${target}.json`),
  JSON.stringify(summary, null, 2) + '\n'
)
console.log(JSON.stringify(summary))
assert.equal(summary.passed, true, 'Lifecycle qualification failed; inspect raw reports')
