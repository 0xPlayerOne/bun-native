import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { guardWorkflow, MANUAL_DISPATCH_GUARD } from '../scripts/sync-foundry.ts'

const path = resolve(import.meta.dir, '../.github/workflows/cef-runtime.yml')
const source = await readFile(path, 'utf8')
const workflow = Bun.YAML.parse(source) as {
  on: { workflow_dispatch: { inputs: Record<string, { options: string[]; default: string }> } }
  permissions: Record<string, string>
  jobs: Record<
    string,
    { if: string; 'timeout-minutes': number; 'runs-on': string; steps: Record<string, unknown>[] }
  >
}

test('manual platform choices stay on bounded standard hosted runners', () => {
  expect(workflow.on.workflow_dispatch.inputs['platform']!.options).toEqual([
    'windows',
    'linux',
    'macos',
    'all',
  ])
  expect(workflow.on.workflow_dispatch.inputs['platform']!.default).toBe('windows')
  expect(workflow.on.workflow_dispatch.inputs['suite']!.options).toEqual([
    'portable',
    'smoke',
    'full',
    'm4-acceptance',
  ])
  expect(workflow.permissions).toEqual({ contents: 'read' })
  for (const name of ['manual-plan', 'manual-native']) {
    expect(workflow.jobs[name]!.if).toBe(MANUAL_DISPATCH_GUARD)
    expect(workflow.jobs[name]!['timeout-minutes']).toBeLessThanOrEqual(60)
  }
  expect(source).not.toContain('self-hosted')
  expect(source).not.toContain('secrets.')
})

test('manual dispatch survives Foundry sync without unpausing automatic CI', () => {
  expect(guardWorkflow(source, true)).toBe(source)
  expect(guardWorkflow(guardWorkflow(source, false), true)).toBe(source)
  for (const name of ['cef']) {
    expect(workflow.jobs[name]!.if).toContain("vars.CI_BILLING_PAUSED == 'false'")
    expect(workflow.jobs[name]!.if).toContain("github.event_name == 'pull_request'")
    expect(workflow.jobs[name]!.if).toContain('draft == false')
  }
})

test('manual exception rejects absent dispatch and expressions with additional events', () => {
  const template = (trigger: string, condition: string) =>
    `on:\n  ${trigger}:\njobs:\n  run:\n    if: ${condition}\n    runs-on: ubuntu-24.04\n`
  expect(() => guardWorkflow(template('push', MANUAL_DISPATCH_GUARD), true)).toThrow(
    'explicit workflow_dispatch'
  )
  for (const suffix of [' || true', " || github.event_name == 'push'"]) {
    expect(() =>
      guardWorkflow(template('workflow_dispatch', MANUAL_DISPATCH_GUARD + suffix), true)
    ).toThrow()
  }
})

test('diagnostics are bounded, no runtime publication or credentials persist', () => {
  const native = workflow.jobs['manual-native']!
  const uploads = native.steps.filter((step) =>
    String(step['uses']).startsWith('actions/upload-artifact@')
  )
  expect(uploads).toHaveLength(1)
  expect(uploads[0]!['with']).toMatchObject({
    path: '.bunly/hosted-evidence/',
    'retention-days': 7,
  })
  expect(source).toContain('persist-credentials: false')
  expect(source).toContain('hosted-windows.ps1')
  expect(source).not.toContain('continue-on-error: true')
})
