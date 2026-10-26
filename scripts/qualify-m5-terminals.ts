/** Execute all maintained M5 terminal workloads, retaining failures across adapters. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
const root = resolve(import.meta.dir, '..')
const [app, ...options] = process.argv.slice(2)
assert.ok(app, 'Use qualify-m5-terminals PREPARED_APP --functional | --samples N --warmups N')
assert.equal(Bun.version, '1.4.3')
const source = sourceIdentity(root)
assert.ok(source.clean, 'Combined acceptance requires clean committed source')
const parent = join(root, '.bunly/m5/combined-terminals')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
const cases = [
  {
    id: 'required-functional-115',
    script: 'scripts/qualify-cef-terminals.ts',
    args: [app, '--functional'],
  },
  { id: 'cef-load', script: 'scripts/qualify-cef-terminals.ts', args: [app, '--load', ...options] },
  { id: 'electron-load', script: 'scripts/qualify-electron-terminal-load.ts', args: options },
]
const results: Record<string, unknown>[] = []
for (const scenario of cases) {
  const child = Bun.spawn([process.execPath, join(root, scenario.script), ...scenario.args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'inherit',
    env: process.env,
  })
  // Consume all output even on overflow; never strand the owned child/observer.
  let stdout = '',
    overflow = false
  for await (const chunk of child.stdout) {
    if (stdout.length + chunk.length <= 1024 * 1024) stdout += new TextDecoder().decode(chunk)
    else overflow = true
  }
  const exitCode = await child.exited
  await writeFile(join(work, `${scenario.id}.stdout.txt`), stdout, { flag: 'wx', mode: 0o600 })
  const result: Record<string, unknown> = { id: scenario.id, exitCode, passed: false, overflow }
  results.push(result)
  try {
    assert.equal(overflow, false)
    const line = stdout.trim().split('\n').at(-1)!
    const receipt = JSON.parse(line)
    assert.equal(typeof receipt.output, 'string')
    const bytes = await readFile(receipt.output)
    assert.ok(bytes.length < 128 * 1024 * 1024)
    const report = JSON.parse(bytes.toString('utf8'))
    result['report'] = receipt.output
    result['sha256'] = createHash('sha256').update(bytes).digest('hex')
    result['source'] = report.sourceBefore
    result['trials'] = report.trials.map((trial: Record<string, unknown>) => ({
      index: trial['index'],
      mode: trial['mode'],
      warmup: trial['warmup'],
      passed: trial['passed'],
      failure: trial['failure'] ?? null,
    }))
    assert.equal(report.sourceBefore.commit, source.commit)
    assert.equal(report.sourceAfter.commit, source.commit)
    assert.ok(report.sourceBefore.clean && report.sourceAfter.clean)
    if (scenario.id !== 'electron-load')
      assert.equal(
        report.backendBuild?.['main.js']?.source,
        'scripts/cef-bootstrap.ts',
        'Current bootstrap was not built'
      )
    assert.equal(exitCode, 0)
    assert.equal(report.passed, true)
    assert.ok(
      report.trials.length && report.trials.every((trial: { passed: boolean }) => trial.passed)
    )
    result.passed = true
  } catch (error) {
    result['failure'] = error instanceof Error ? error.message : String(error)
  }
  console.log(JSON.stringify({ id: scenario.id, passed: result.passed }))
}
const unchanged = sourceIdentity(root)
const passed =
  results.every((result) => result.passed) && unchanged.clean && unchanged.commit === source.commit
const report = {
  schema: 1,
  source,
  sourceAfter: unchanged,
  passed,
  results,
  milestoneAccepted: false,
  ratios: null,
  performanceBudgets: null,
  remaining: [
    'Actual foreground/background/minimized load with native state readback after #119 integration.',
    'Current-head platform qualification remains coordinator-owned.',
    'Matched engine/security and quiet calibration; failed historical/current trials and watchdogs remain blockers.',
    'Independent parent/descendant supervision acceptance remains required.',
  ],
  classification:
    'combined-required-functional-and-same-workload-load-execution; not complete M5 acceptance',
}
const output = join(work, 'report.json')
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ passed, output, milestoneAccepted: false }))
if (!passed) process.exitCode = 1
