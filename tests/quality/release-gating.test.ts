import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')

type Job = {
  if?: string
  needs?: string | string[]
  uses?: string
  permissions?: Record<string, string>
  with?: Record<string, unknown>
  steps?: { name?: string; run?: string }[]
}
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> }

function workflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow
}

test('the required Validation / Gate waits for a real four-language CodeQL analysis (#607)', () => {
  const validation = workflow('bun-native.yml')
  const codeql = validation.jobs.codeql
  expect(codeql?.uses).toStartWith('0xPlayerOne/code-foundry/.github/workflows/codeql.yml@')
  expect(codeql?.permissions?.['security-events']).toBe('write')

  const plan = JSON.parse(String(codeql?.with?.plan)) as { enabled: string; matrix: string }
  expect(plan.enabled).toBe('true')
  const matrix = JSON.parse(plan.matrix) as { display: string; changed: boolean }[]
  expect(matrix.map((entry) => entry.display).sort()).toEqual([
    'Actions',
    'Python',
    'Rust',
    'TypeScript',
  ])
  // An unchanged row runs "Not applicable" and succeeds without analysis.
  expect(matrix.every((entry) => entry.changed === true)).toBe(true)

  const gate = validation.jobs.gate
  expect(gate?.needs).toContain('codeql')
  expect(gate?.permissions?.actions).toBe('read')
  const check = gate?.steps?.find((step) => step.name?.includes('real CodeQL analysis'))
  for (const spec of [
    'Actions:Analyze',
    'TypeScript:Analyze',
    'Python:Analyze',
    'Rust:Analyze Rust',
  ])
    expect(check?.run).toContain(spec)
})

test('the standalone CodeQL workflow no longer scans pull requests or main pushes twice', () => {
  const codeql = workflow('codeql.yml')
  expect(Object.keys(codeql.on).sort()).toEqual(['schedule', 'workflow_dispatch'])
})

// GitHub rejects a caller whose reusable workflow asks for more than the caller
// grants, and a rejected scheduled workflow never runs at all (#620).
test('the scheduled audit grants every permission the nested Validation jobs request', () => {
  const level = { none: 0, read: 1, write: 2 } as Record<string, number>
  const audit = workflow('native-audit.yml')
  const granted = audit.jobs.validation?.permissions ?? {}
  const validation = workflow('bun-native.yml') as Workflow & {
    permissions?: Record<string, string>
  }
  const requested = [validation.permissions ?? {}]
  for (const job of Object.values(validation.jobs)) requested.push(job.permissions ?? {})
  const missing: string[] = []
  for (const permissions of requested)
    for (const [scope, access] of Object.entries(permissions))
      if ((level[granted[scope] ?? 'none'] ?? 0) < (level[access] ?? 0))
        missing.push(`${scope}: ${access}`)
  expect([...new Set(missing)]).toEqual([])
  expect(granted).toMatchObject({ actions: 'read', 'security-events': 'write' })
})

test('stable releases wait for the exact main head to pass its own Validation (#614)', () => {
  const release = workflow('release.yml')
  expect(Object.keys(release.on).sort()).toEqual(['workflow_dispatch', 'workflow_run'])
  expect(release.on.workflow_run).toEqual({
    workflows: ['Bun Native Validation'],
    types: ['completed'],
    branches: ['main'],
  })

  const qualified = release.jobs.qualified?.steps?.[0]?.run ?? ''
  expect(qualified).toContain('"$RUN_EVENT" != push')
  expect(qualified).toContain('"$RUN_CONCLUSION" != success')
  expect(qualified).toContain('"$target" != "$main_sha"')
  expect(qualified).toContain('actions/workflows/bun-native.yml/runs?head_sha=$target&event=push')

  const job = release.jobs.release
  expect(job?.needs).toBe('qualified')
  expect(job?.if).toBe("needs.qualified.outputs.release == 'true'")
})
