import { expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  guardOpenCodeScan,
  isolateDraftConcurrency,
  PR_READINESS_SUFFIX,
} from '../scripts/sync-foundry.ts'

const directory = resolve(import.meta.dir, '../.github/workflows')
const draftGuard =
  "(github.event_name != 'pull_request' || github.event.pull_request.draft == false)"
const prReady = "github.event_name == 'pull_request' && github.event.pull_request.draft == false"

// A top-level OR could bypass a guard even if its text appears in the job.
function topLevelOr(expression: string): boolean {
  let depth = 0,
    quoted = false
  for (const [i, c] of [...expression].entries()) {
    if (c === "'") quoted = !quoted
    else if (!quoted && c === '(') depth++
    else if (!quoted && c === ')') depth--
    else if (!quoted && depth === 0 && expression.slice(i, i + 2) === '||') return true
  }
  return depth !== 0 || quoted
}

test('Code Foundry draft protection covers every PR CI caller and runner', async () => {
  const config = Bun.YAML.parse(
    await readFile(resolve(directory, '../code-foundry.yml'), 'utf8')
  ) as Record<string, unknown>
  expect(config['draft_protection']).toBe(true)
  const seen = new Set<string>()
  for (const file of (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = Bun.YAML.parse(await readFile(resolve(directory, file), 'utf8')) as Record<
      string,
      unknown
    >
    const triggers = workflow['on'] as Record<string, unknown>
    if (Object.hasOwn(triggers, 'pull_request_target')) {
      expect(file).toBe('draft-enforcement.yml')
      continue // Trusted-base lightweight Draft Guard changes ordinary PR state.
    }
    if (!Object.hasOwn(triggers, 'pull_request')) continue
    const pr = triggers['pull_request'] as Record<string, unknown>
    if (file === 'draft-control.yml') {
      expect(pr['types']).toEqual(['converted_to_draft'])
      continue // Lightweight cancellation must run precisely when converted to draft.
    }
    seen.add(file)
    const concurrency = workflow['concurrency'] as Record<string, unknown>
    expect(String(concurrency['group']), file).toEndWith(PR_READINESS_SUFFIX)
    expect(concurrency['cancel-in-progress'], file).toBe(
      "${{ github.event_name == 'pull_request' }}"
    )
    expect([...(pr['types'] as string[])].sort(), file).toEqual(
      ['ready_for_review', 'synchronize'].sort()
    )
    const jobs = workflow['jobs'] as Record<string, Record<string, unknown>>
    for (const [name, job] of Object.entries(jobs)) {
      const condition = String(job['if'] ?? '')
      expect(topLevelOr(condition), `${file}/${name}: top-level OR`).toBe(false)
      const gated =
        condition.includes(draftGuard) ||
        condition.includes(prReady) ||
        (Object.keys(triggers).every((key) => key === 'pull_request') &&
          condition.includes('github.event.pull_request.draft == false')) ||
        (condition.includes("github.event_name == 'push'") &&
          !condition.includes('github.event_name !='))
      expect(gated, `${file}/${name}: missing ready or push-only gate`).toBe(true)
    }
  }
  expect(seen.has('validation.yml')).toBe(true)
  expect(seen.has('ci.yml')).toBe(true)
  expect(seen.has('opencode-security.yml')).toBe(true)
})

test('generated OpenCode scanner keeps its own draft gate through sync', () => {
  const previous =
    "      needs.detect.outputs.enabled == 'true' &&\n      needs.detect.outputs.token == 'true'"
  const input = `jobs:\n  scan:\n    if: >-\n      vars.CI_BILLING_PAUSED == 'false' &&\n${previous}\n`
  const once = guardOpenCodeScan(input)
  expect(once).toContain(draftGuard)
  expect(guardOpenCodeScan(once)).toBe(once)
  expect(() => guardOpenCodeScan('unexpected')).toThrow('Unexpected OpenCode scan condition')
})

test('push, schedule and manual entrypoints remain available outside PR validation', async () => {
  const workflow = async (name: string) =>
    Bun.YAML.parse(await readFile(resolve(directory, name), 'utf8')) as Record<string, unknown>
  for (const name of ['ci.yml', 'validation.yml']) {
    const on = (await workflow(name))['on'] as Record<string, unknown>
    expect((on['push'] as Record<string, unknown>)['branches'], name).toEqual(['main'])
  }
  for (const name of [
    'ci.yml',
    'benchmarks.yml',
    'development.yml',
    'electrobun.yml',
    'cef-typecheck.yml',
    'kernel-counters.yml',
    'qualification.yml',
    'cef-runtime.yml',
    'opencode-security.yml',
  ]) {
    const on = (await workflow(name))['on'] as Record<string, unknown>
    expect(Object.hasOwn(on, 'workflow_dispatch'), name).toBe(true)
  }
  const on = (await workflow('validation-audit.yml'))['on'] as Record<string, unknown>
  expect(Array.isArray(on['schedule'])).toBe(true)
  expect(Object.hasOwn(on, 'workflow_dispatch')).toBe(true)
  const validation = await workflow('validation.yml')
  const jobs = validation['jobs'] as Record<string, Record<string, unknown>>
  expect(String(jobs['validation']!['if'])).toContain(
    "startsWith(github.event.pull_request.head.ref, 'release-please--branches--main')"
  )
})

test('Electrobun draft skips cannot collide with its required ready check context', async () => {
  const workflow = Bun.YAML.parse(
    await readFile(resolve(directory, 'electrobun.yml'), 'utf8')
  ) as Record<string, unknown>
  const jobs = workflow['jobs'] as Record<string, Record<string, unknown>>
  expect(jobs['electrobun']!['name']).toBe(
    "${{ github.event_name == 'pull_request' && github.event.pull_request.draft && 'electrobun (draft)' || 'electrobun' }}"
  )
  expect(String(jobs['electrobun']!['if'])).toContain(draftGuard)
})

test('draft and ready events use separate stable groups without changing non-PR groups', () => {
  const source =
    "on:\n  pull_request:\n  push:\nconcurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\njobs:\n  test:\n    runs-on: ubuntu-latest\n"
  const transformed = isolateDraftConcurrency('custom.yml', source)
  const workflow = Bun.YAML.parse(transformed) as Record<string, unknown>
  const group = String((workflow['concurrency'] as Record<string, unknown>)['group'])
  expect(group).toBe('ci-${{ github.ref }}' + PR_READINESS_SUFFIX)
  expect(isolateDraftConcurrency('custom.yml', transformed)).toBe(transformed)
  expect(isolateDraftConcurrency('draft-control.yml', source)).toBe(source)
  expect(isolateDraftConcurrency('manual.yml', source.replace('  pull_request:\n', ''))).toBe(
    source.replace('  pull_request:\n', '')
  )
  expect(() =>
    isolateDraftConcurrency('bad.yml', source.replace('  group: ci-', '  group: [ci-'))
  ).toThrow()
  // GitHub's conditional suffix has no head SHA or action: both ready transitions
  // and ready synchronize events share the ready group; draft events cannot enter it.
  expect(PR_READINESS_SUFFIX).toBe(
    "${{ github.event_name == 'pull_request' && (github.event.pull_request.draft && '-draft' || '-ready') || '' }}"
  )
})
