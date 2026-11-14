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
    jobs: Record<string, { if: string; steps: { with?: Record<string, string>; run?: string }[] }>
  }
  const pin = JSON.parse(readFileSync(join(root, 'toolchain.json'), 'utf8')) as {
    bun: { revision: string }
  }
  expect(workflow.on.pull_request.types).toEqual(['labeled'])
  expect(workflow.permissions).toEqual({ contents: 'read' })
  const job = workflow.jobs['local-runtime']!
  expect(job.if).toContain("github.event.label.name == 'diagnostic:windows-runtime'")
  expect(job.if).toContain('github.event.pull_request.draft == false')
  expect(job.steps.find((step) => step.with?.repository === 'oven-sh/bun')?.with?.ref).toBe(
    pin.bun.revision
  )
  const webkit = job.steps.find((step) => step.with?.repository === 'oven-sh/WebKit')?.with
  expect(webkit?.ref).toBe('4d45755fed4aeef19e95beb90d3d0c884a2812bd')
  expect(webkit?.['sparse-checkout']).toContain('Source/JavaScriptCore')
  expect(webkit?.['sparse-checkout']).not.toContain('LayoutTests')
  const build = job.steps.find((step) => step.run?.includes('--profile=release-local'))?.run
  expect(build).toContain('--profile=release-local --build-dir=build/release-local -j2')
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
