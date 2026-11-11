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
  const audit = workflow('native-audit.yml')
  const granted = audit.jobs.validation?.permissions ?? {}
  const validation = workflow('bun-native.yml') as Workflow & {
    permissions?: Record<string, string>
  }
  const requested = [validation.permissions ?? {}]
  for (const job of Object.values(validation.jobs)) requested.push(job.permissions ?? {})
  // A local reusable workflow's own jobs are nested one level further.
  for (const job of Object.values(validation.jobs))
    if (job.uses?.startsWith('./.github/workflows/'))
      for (const nested of Object.values(
        workflow(job.uses.slice('./.github/workflows/'.length)).jobs
      ))
        requested.push(nested.permissions ?? {})
  expect(ungranted(granted, requested)).toEqual([])
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
  expect(job?.needs).toEqual(['qualified', 'linux-provenance'])
  expect(job?.if).toBe("needs.qualified.outputs.release == 'true'")
})

const level = { none: 0, read: 1, write: 2 } as Record<string, number>
function ungranted(granted: Record<string, string>, requested: Record<string, string>[]) {
  const missing: string[] = []
  for (const permissions of requested)
    for (const [scope, access] of Object.entries(permissions))
      if ((level[granted[scope] ?? 'none'] ?? 0) < (level[access] ?? 0))
        missing.push(`${scope}: ${access}`)
  return [...new Set(missing)]
}

// Keyless Sigstore provenance for the Linux host archive (#249).
test('Native Linux attests and verifies the host archive only on main pushes, with its caller granting OIDC', () => {
  const linux = workflow('native-linux.yml')
  const native = linux.jobs.native!
  expect(native.permissions).toEqual({
    contents: 'read',
    'id-token': 'write',
    attestations: 'write',
  })
  const validation = workflow('bun-native.yml')
  expect(validation.jobs.native?.uses).toBe('./.github/workflows/native-linux.yml')
  expect(ungranted(validation.jobs.native?.permissions ?? {}, [native.permissions ?? {}])).toEqual(
    []
  )

  const steps = (native.steps ?? []) as {
    id?: string
    name?: string
    if?: string
    uses?: string
    run?: string
    with?: Record<string, unknown>
  }[]
  const attest = steps.find((step) => step.id === 'host-provenance')
  expect(attest?.uses).toStartWith('actions/attest-build-provenance@')
  expect(attest?.uses).toMatch(/@[0-9a-f]{40}$/)
  expect(attest?.if).toContain("github.event_name == 'push'")
  expect(attest?.if).toContain("github.ref == 'refs/heads/main'")
  expect(attest?.if).toContain('matrix.shard == 1')
  expect(String(attest?.with?.['subject-path'])).toEndWith('/unsigned-native-host.tar.gz')
  const verify = steps.find((step) => step.name?.includes('provenance as a consumer would'))
  expect(verify?.if).toContain("steps.host-provenance.outcome == 'success'")
  expect(verify?.run).toContain('bun scripts/quality/linux-provenance.ts verify')
  expect(verify?.run).toContain('--signer-workflow .github/workflows/native-linux.yml')
  expect(verify?.run).toContain('--source-digest "$GITHUB_SHA"')
  const upload = steps.find(
    (step) => step.with?.['name'] === 'linux-host-provenance-${{ runner.arch }}'
  )
  expect(upload?.if).toBe(verify?.if)
})

test('a release refuses a main head whose Linux host archive lacks verified provenance (#249)', () => {
  const release = workflow('release.yml')
  const job = release.jobs['linux-provenance']
  expect(job?.needs).toBe('qualified')
  expect(job?.if).toBe("needs.qualified.outputs.release == 'true'")
  expect(job?.permissions).toEqual({ actions: 'read', attestations: 'read', contents: 'read' })
  const script = (job?.steps ?? []).map((step) => step.run ?? '').join('\n')
  expect(script).toContain('--name linux-host-provenance-X64')
  expect(script).toContain('bun scripts/quality/linux-provenance.ts verify')
  expect(script).toContain('--source-ref refs/heads/main --source-digest "$COMMIT"')
  expect(release.jobs.release?.needs).toContain('linux-provenance')
})
