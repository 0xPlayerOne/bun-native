import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const readyEvents = ['opened', 'reopened', 'ready_for_review', 'synchronize'] as const

// Both inline and block-style GitHub Actions activity lists occur in this repository.
function pullRequestTypes(workflow: string): string[] {
  const lines = workflow.split(/\r?\n/)
  const start = lines.indexOf('  pull_request:')
  if (start < 0) throw new Error('missing pull_request trigger')

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (/^  [a-z][a-z_-]*:/.test(line)) break

    const inline = /^    types: \[([^\]]+)\]$/.exec(line)
    if (inline?.[1] !== undefined) {
      return inline[1].split(',').map((event) => event.trim())
    }
    if (line !== '    types:') continue

    const types: string[] = []
    for (let next = index + 1; next < lines.length; next++) {
      const item = /^      - ([a-z_]+)$/.exec(lines[next] ?? '')
      if (item?.[1] === undefined) break
      types.push(item[1])
    }
    return types
  }

  throw new Error('missing pull_request.types')
}

// Each implementation job must preserve the draft guard; a marker elsewhere in
// the workflow is insufficient when a new job is added.
function unguardedJobs(workflow: string, exempt: readonly string[] = []): string[] {
  const parsed = Bun.YAML.parse(workflow) as { jobs?: Record<string, { if?: string }> }
  const jobs = parsed.jobs
  if (!jobs || Object.keys(jobs).length === 0) throw new Error('missing workflow jobs')
  return Object.entries(jobs)
    .filter(
      ([name, job]) =>
        !exempt.includes(name) && !job.if?.includes('github.event.pull_request.draft == false')
    )
    .map(([name]) => name)
}

const readyOnlyWorkflows = [
  '.github/workflows/bun-native.yml',
  '.github/workflows/opencode-security.yml',
  '.github/workflows/benchmark-comparison.yml',
  '.github/workflows/native-bridge-pairs.yml',
] as const

for (const path of readyOnlyWorkflows) {
  test(`${path} covers ready-created and reopened PRs without validating drafts`, () => {
    const source = readFileSync(join(root, path), 'utf8')
    const types = pullRequestTypes(source)

    for (const event of readyEvents) expect(types).toContain(event)
    expect(new Set(types).size).toBe(types.length)
    const exempt = path === '.github/workflows/bun-native.yml' ? ['gate'] : []
    expect(unguardedJobs(source, exempt)).toEqual([])
    if (exempt.length) {
      const jobs = (Bun.YAML.parse(source) as { jobs: Record<string, { if?: string }> }).jobs
      expect(jobs.gate?.if).toBe('always()')
    }
  })
}

test('draft guards apply to every implementation job, not merely the workflow', () => {
  const fixture = [
    'jobs:',
    '  guarded:',
    '    if: github.event.pull_request.draft == false',
    '  unguarded:',
    '    runs-on: ubuntu-24.04',
  ].join('\n')
  expect(unguardedJobs(fixture)).toEqual(['unguarded'])
  expect(() => unguardedJobs('name: no jobs')).toThrow('missing workflow jobs')
})

test('Windows runtime source build is limited to its explicit label and exact Bun revision', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, '.github/workflows/windows-runtime-control.yml'), 'utf8')
  ) as {
    on: { pull_request: { types: string[] } }
    permissions: Record<string, string>
    jobs: Record<
      string,
      {
        if: string
        env?: Record<string, string>
        steps: {
          name?: string
          if?: string
          with?: Record<string, string>
          env?: Record<string, string>
          run?: string
        }[]
      }
    >
  }
  const pin = JSON.parse(readFileSync(join(root, 'toolchain.json'), 'utf8')) as {
    bun: { revision: string }
  }
  expect(workflow.on.pull_request.types).toEqual(['labeled'])
  expect(workflow.permissions).toEqual({ contents: 'read' })
  const job = workflow.jobs['local-runtime']!
  expect(job.if).toContain("github.event.label.name == 'diagnostic:windows-runtime'")
  expect(job.if).toContain("github.event.label.name == 'diagnostic:windows-zero-registers'")
  expect(job.if).toContain("github.event.label.name == 'diagnostic:windows-snapshot-roots'")
  expect(job.if).toContain("github.event.label.name == 'diagnostic:windows-origin-ranges'")
  expect(job.env?.BUN_NATIVE_DIAG_SNAPSHOT_SAFE).toContain('diagnostic:windows-origin-ranges')
  expect(job.if).toContain('github.event.pull_request.draft == false')
  expect(job.steps.find((step) => step.with?.repository === 'oven-sh/bun')?.with?.ref).toBe(
    pin.bun.revision
  )
  const webkit = job.steps.find((step) => step.with?.repository === 'oven-sh/WebKit')?.with
  expect(webkit?.ref).toBe('4d45755fed4aeef19e95beb90d3d0c884a2812bd')
  expect(webkit?.['sparse-checkout']).toContain('Source/JavaScriptCore')
  expect(webkit?.['sparse-checkout']).not.toContain('LayoutTests')
  const zeroRegisters = job.steps.find((step) =>
    step.run?.includes('webkit-windows-zero-registers-experiment.patch')
  )!
  expect(zeroRegisters.if).toBe("github.event.label.name == 'diagnostic:windows-zero-registers'")
  expect(zeroRegisters.run).toContain('git -C $webkit apply --check $patch')
  expect(zeroRegisters.run).toContain('experimental-zero-registers-hash.txt')
  expect(zeroRegisters.run).toContain('not a GC correctness or production AOT qualification')
  const snapshotRoots = job.steps.find((step) =>
    step.run?.includes('webkit-conservative-snapshot-experiment.patch')
  )!
  expect(snapshotRoots.if).toContain(
    "github.event.label.name == 'diagnostic:windows-snapshot-roots'"
  )
  expect(snapshotRoots.if).toContain(
    "github.event.label.name == 'diagnostic:windows-origin-ranges'"
  )
  expect(snapshotRoots.run).toContain('git -C $webkit apply --check $patch')
  expect(snapshotRoots.run).toContain('not production AOT')
  const originRanges = job.steps.find((step) =>
    step.run?.includes('webkit-conservative-origin-experiment.patch')
  )!
  expect(originRanges.if).toBe("github.event.label.name == 'diagnostic:windows-origin-ranges'")
  expect(originRanges.run).toContain('git -C $webkit apply --check $patch')
  expect(originRanges.run).toContain('no stack contents or slot addresses')
  expect(job.steps.indexOf(originRanges)).toBeGreaterThan(job.steps.indexOf(snapshotRoots))
  const originControl = job.steps.find(
    (step) => step.name === 'Verify native stack origin control'
  )!
  expect(originControl.if).toBe("github.event.label.name == 'diagnostic:windows-origin-ranges'")
  expect(originControl.run).toContain('snapshot_safe_run.py')
  expect(originControl.run).toContain('Unpatched origin control did not reject missing metadata')
  expect(originControl.run).toContain("@('development', 'compiled-untrimmed')")
  const originReports = job.steps.find((step) => step.name === 'Verify next-task origin reports')!
  expect(originReports.if).toBe("github.event.label.name == 'diagnostic:windows-origin-ranges'")
  expect(originReports.run).toContain('originCounts.sameJob')
  expect(originReports.run).toContain('originCounts.nextTask')
  const reportControl = job.steps.find((step) => step.name === 'Check boundary report parsing')!
  const boundary = job.steps.find(
    (step) => step.name === 'Observe the instrumented collection boundary'
  )!
  expect(reportControl.if).toBe("github.event.label.name == 'diagnostic:windows-origin-ranges'")
  expect(reportControl.run).toContain('ConvertFrom-Json -AsHashtable')
  expect(reportControl.run).toContain('"string":1,"String":2')
  expect(boundary.run).toContain('Get-Content $prefix -Raw | ConvertFrom-Json -AsHashtable')
  expect(job.steps.indexOf(reportControl)).toBeLessThan(job.steps.indexOf(boundary))
  for (const repository of ['oven-sh/bun', 'oven-sh/WebKit']) {
    const checkout = job.steps.find((step) => step.with?.repository === repository)
    expect(checkout?.env?.GIT_CONFIG_KEY_0).toBe('core.autocrlf')
    expect(String(checkout?.env?.GIT_CONFIG_VALUE_0)).toBe('false')
  }
  expect(job.steps.some((step) => step.run?.includes('hash-object --no-filters'))).toBe(true)
  const build = job.steps.find((step) => step.run?.includes('--profile=release-local'))?.run
  expect(build).toContain('--profile=release-local --build-dir=build/release-local -j2')
  const untrimmed = job.steps.find((step) => step.run?.includes('local-compiled-scope.txt'))?.run
  expect(untrimmed).toContain("$inspection.runtime.jit -ne 'present'")
  expect(untrimmed).toContain('not a qualified production AOT executable')
  const candidate = workflow.jobs['candidate-runtime']!
  expect(candidate.if).toContain("github.event.label.name == 'diagnostic:windows-candidate'")
  expect(candidate.if).toContain('github.event.pull_request.draft == false')
  const prepare = candidate.steps.find((step) =>
    step.run?.includes('Candidate archive integrity')
  )?.run
  expect(prepare).toContain('runtime.jit !== "unused"')
  const compare = candidate.steps.find((step) => step.run?.includes('positive control failed'))?.run
  expect(compare).toContain('foreach ($trial in 0..4)')
  expect(compare).toContain('headless-adapter-control.py')
  expect(compare).toContain('react-dispatch-control.py')
  expect(compare).toContain('[System.IO.File]::WriteAllBytes($toolchain, $original)')
})

test('macOS stream feasibility probe requires its explicit label and a ready PR', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, '.github/workflows/macos-stream-control.yml'), 'utf8')
  ) as {
    on: { pull_request: { types: string[] } }
    permissions: Record<string, string>
    jobs: Record<string, { if: string }>
  }
  expect(workflow.on.pull_request.types).toEqual(['labeled'])
  expect(workflow.permissions).toEqual({ contents: 'read' })
  const job = workflow.jobs['owned-window-stream']!
  expect(job.if).toContain("github.event.label.name == 'diagnostic:macos-stream'")
  expect(job.if).toContain('github.event.pull_request.draft == false')
})

test('real fixture stream control is opt-in and cannot run paired comparisons', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, '.github/workflows/benchmark-comparison.yml'), 'utf8')
  ) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; default: boolean }> } }
    jobs: Record<string, { env?: Record<string, string>; steps: { if?: string; run?: string }[] }>
  }
  expect(workflow.on.workflow_dispatch.inputs['startup-only']).toMatchObject({
    type: 'boolean',
    default: false,
  })
  const job = workflow.jobs['electrobun-smoke']!
  expect(job.env?.['STREAM_CONTROL']).toBe("${{ inputs['startup-only'] }}")
  const compile = job.steps.find((step) => step.run?.includes('real-window-stream-probe.swift'))!
  expect(compile.if).toBe("inputs['startup-only'] == true")
  expect(compile.run).toContain('test "$STREAM_PAIRED_MACOS" != \'true\'')
  const qualify = job.steps.filter((step) => step.run?.includes('visible-smoke-macos.ts'))
  expect(qualify).toHaveLength(2)
  for (const step of qualify) expect(step.run).toContain('if [[ "$STREAM_CONTROL" == \'true\' ]]')
})

test('paired input diagnostic requires an explicit dispatch and leaves ordinary jobs enabled by default', () => {
  const source = readFileSync(join(root, '.github/workflows/benchmark-comparison.yml'), 'utf8')
  const parsed = Bun.YAML.parse(source) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; default: boolean }> } }
    jobs: Record<string, { if: string }>
  }
  expect(parsed.on.workflow_dispatch.inputs['paired-only']).toMatchObject({
    type: 'boolean',
    default: false,
  })
  expect(parsed.on.workflow_dispatch.inputs['startup-only']).toMatchObject({
    type: 'boolean',
    default: false,
  })
  expect(parsed.on.workflow_dispatch.inputs['paired-macos']).toMatchObject({
    type: 'boolean',
    default: false,
  })
  expect(parsed.on.workflow_dispatch.inputs['paired-macos-trials']).toMatchObject({
    default: '10',
  })
  expect(parsed.on.workflow_dispatch.inputs['electrobun-smoke']).toMatchObject({
    type: 'boolean',
    default: false,
  })
  expect(parsed.jobs['electrobun-smoke']!.if).toContain("github.event_name == 'workflow_dispatch'")
  expect(parsed.jobs['electrobun-smoke']!.if).toContain("inputs['electrobun-smoke'] == true")
  for (const job of ['linux', 'macos', 'windows', 'paired-click'])
    expect(parsed.jobs[job]!.if).toContain("inputs['electrobun-smoke'] != true")
  expect(parsed.jobs['paired-click']!.if).toContain("github.event_name == 'workflow_dispatch'")
  expect(parsed.jobs['paired-click']!.if).toContain("inputs['paired-only'] == true")
  expect(parsed.jobs['paired-click']!.if).toContain("inputs['paired-macos'] != true")
  expect(parsed.jobs['paired-click']!.if).toContain("inputs['startup-only'] != true")
  for (const condition of [
    "github.event_name == 'workflow_dispatch'",
    "inputs['paired-only'] == true",
    "inputs['startup-only'] == true",
    "inputs['paired-macos'] != true",
    "inputs['electrobun-smoke'] != true",
  ])
    expect(parsed.jobs['event-registry-pairs']!.if).toContain(condition)
  for (const condition of [
    "github.event_name == 'workflow_dispatch'",
    "inputs['paired-only'] == true",
    "inputs['paired-macos'] == true",
    "inputs['electrobun-smoke'] != true",
  ])
    for (const job of ['tree-path-pairs', 'tree-path-allocations'])
      expect(parsed.jobs[job]!.if).toContain(condition)
  for (const job of ['linux', 'macos', 'windows'])
    expect(parsed.jobs[job]!.if).toContain("inputs['paired-only'] != true")
  for (const job of ['linux', 'windows'])
    expect(parsed.jobs[job]!.if).toContain("inputs['startup-only'] != true")
  for (const job of ['linux', 'windows'])
    expect(parsed.jobs[job]!.if).toContain("inputs['paired-macos'] != true")
  for (const condition of [
    "github.event_name == 'workflow_dispatch'",
    "inputs['paired-only'] == true",
    "inputs['paired-macos'] == true",
    "inputs['startup-only'] == true",
    "inputs['electrobun-smoke'] != true",
  ])
    expect(parsed.jobs['windows-retention-control']!.if).toContain(condition)
  for (const job of ['tree-path-pairs', 'tree-path-allocations'])
    expect(parsed.jobs[job]!.if).toContain("inputs['startup-only'] != true")
})

test('event contract parsing supports both activity syntaxes and fails closed', () => {
  expect(pullRequestTypes('on:\n  pull_request:\n    types: [opened, reopened]\n')).toEqual([
    'opened',
    'reopened',
  ])
  expect(
    pullRequestTypes('on:\n  pull_request:\n    types:\n      - opened\n      - reopened\n')
  ).toEqual(['opened', 'reopened'])
  expect(() => pullRequestTypes('on:\n  push:\n    branches: [main]\n')).toThrow(
    'missing pull_request trigger'
  )
  expect(() => pullRequestTypes('on:\n  pull_request:\n    branches: [main]\n')).toThrow(
    'missing pull_request.types'
  )
})
