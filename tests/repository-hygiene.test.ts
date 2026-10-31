import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  FOUNDRY_SOURCE,
  FOUNDRY_VERSION,
  customizeBugReport,
  pinFoundryWorkflow,
  syncFoundry,
  verifyFoundryState,
  verifyGithubLayout,
} from '../scripts/sync-foundry.ts'

const root = resolve(import.meta.dir, '..')

for (const name of [
  'CONTRIBUTING.md',
  'contributing.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template',
  '.GITHUB',
]) {
  test(`Foundry rejects misplaced ${name} before upstream writes`, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'bunly-layout-'))
    try {
      await writeFile(resolve(directory, name), 'authored content')
      await expect(syncFoundry(directory)).rejects.toThrow()
      expect(await readdir(directory)).toEqual([name])
      expect(await readFile(resolve(directory, name), 'utf8')).toBe('authored content')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('case-insensitive duplicate issue form names are rejected', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'bunly-forms-'))
  try {
    const forms = resolve(directory, '.github/ISSUE_TEMPLATE')
    await mkdir(forms, { recursive: true })
    await writeFile(resolve(forms, 'old.yml'), 'name: Bug report\nbody: []\n')
    await writeFile(resolve(forms, 'new.yml'), 'name: BUG REPORT\nbody: []\n')
    await expect(verifyGithubLayout(directory)).rejects.toThrow('Duplicate issue form')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reviewed Foundry workflow and runtime pins are immutable and idempotent', () => {
  const source = `jobs:\n  check:\n    uses: 0xPlayerOne/code-foundry/.github/workflows/validation.yml@v${FOUNDRY_VERSION}\n    with:\n      runtime-ref: v${FOUNDRY_VERSION}\n`
  const pinned = pinFoundryWorkflow(source)
  expect(pinned).toContain('@' + FOUNDRY_SOURCE)
  expect(pinned).toContain('runtime-ref: ' + FOUNDRY_SOURCE)
  expect(pinFoundryWorkflow(pinned)).toBe(pinned)
  expect(() => pinFoundryWorkflow(source.replaceAll(`v${FOUNDRY_VERSION}`, 'main'))).toThrow(
    'Unreviewed Code Foundry'
  )
  expect(() => pinFoundryWorkflow(source.replaceAll(`v${FOUNDRY_VERSION}`, 'v9.9.9'))).toThrow()
})

test('bug form customization preserves platform-specific diagnostics after sync', () => {
  const source =
    'description: Include the commit, branch, runtime/tool versions, operating system, and affected app or package.\n'
  const changed = customizeBugReport(source)
  expect(changed).toContain('developer and packaged Bun')
  expect(changed).toContain('security profile')
  expect(customizeBugReport(changed)).toBe(changed)
})

test('the actual checkout has one canonical policy layout and the reviewed Foundry overlay', async () => {
  await verifyFoundryState(root)
  const guide = await readFile(resolve(root, '.github/CONTRIBUTING.md'), 'utf8')
  expect(guide).toContain('# Contributing to Bun Native')
  expect(guide).toContain('code-foundry-managed: agent-operating-contract')
  const validation = Bun.YAML.parse(
    await readFile(resolve(root, '.github/workflows/validation.yml'), 'utf8')
  ) as {
    jobs: Record<string, { steps?: { with?: { repository?: string; ref?: string } }[] }>
  }
  const checkouts = Object.values(validation.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.with?.repository === '0xPlayerOne/code-foundry')
  expect(checkouts).toHaveLength(1)
  expect(checkouts[0]!.with?.ref).toBe(FOUNDRY_SOURCE)
})

test('all external Actions and reusable workflows are pinned to complete commit identities', async () => {
  const directory = resolve(root, '.github/workflows')
  for (const file of await readdir(directory)) {
    if (!/\.ya?ml$/.test(file)) continue
    const source = await readFile(resolve(directory, file), 'utf8')
    for (const match of source.matchAll(/^\s*(?:- )?uses:\s+(\S+)/gm)) {
      const action = match[1]!
      if (action.startsWith('./')) continue
      expect(action, `${file}: ${action}`).toMatch(/@[a-f0-9]{40}$/)
    }
  }
})

test('full native CEF qualification stays behind explicit manual dispatch', async () => {
  const workflow = Bun.YAML.parse(
    await readFile(resolve(root, '.github/workflows/cef-runtime.yml'), 'utf8')
  ) as { on: Record<string, unknown>; jobs: Record<string, { steps: { run?: string }[] }> }
  expect(workflow.on).not.toHaveProperty('pull_request')
  expect(Object.keys(workflow.jobs)).toEqual(['manual-plan', 'manual-native'])
  const commands = workflow.jobs['manual-native']!.steps.map((step) => step.run ?? '').join('\n')
  expect(commands).toContain('hosted_cef.py run --suite "$QUALIFICATION_SUITE"')
  expect(commands).toContain('hosted-windows.ps1 -Suite $env:QUALIFICATION_SUITE')
  expect(commands).toContain('--features packaging,rpc-qualification --release')
  expect(commands).toContain('build --locked')
  expect(commands).not.toContain('if: always()')
})

test('foundation CI provides the process observer before portable integration tests', async () => {
  const source = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8')
  const workflow = Bun.YAML.parse(source) as {
    jobs: { foundation: { steps: Record<string, unknown>[]; if: string } }
    on: { pull_request: { types: string[] } }
    concurrency: Record<string, string>
  }
  const steps = workflow.jobs.foundation.steps
  const setup = steps.findIndex((step) => String(step['uses']).startsWith('actions/setup-python@'))
  const install = steps.findIndex(
    (step) => step['name'] === 'Install process-observer prerequisites'
  )
  const checks = steps.findIndex((step) => String(step['run']).includes('bun run check'))
  expect(setup).toBeGreaterThanOrEqual(0)
  expect(install).toBeGreaterThan(setup)
  expect(checks).toBeGreaterThan(install)
  expect(String(steps[install]!['run'])).toContain('-r requirements.txt')
  expect(String(steps[install]!['run'])).toContain('PYTHON=')
  expect(workflow.on.pull_request.types).toContain('ready_for_review')
  expect(workflow.jobs.foundation.if).toContain('draft == false')
  expect(workflow.concurrency['cancel-in-progress']).toContain(
    "github.event_name == 'pull_request'"
  )
})

test('Foundry installs a complete pinned Python environment and restricts discovery to owned tests', async () => {
  const requirements = await readFile(resolve(root, 'requirements.txt'), 'utf8')
  for (const file of [
    'requirements-dev.txt',
    'requirements-format.txt',
    'benchmarks/adapters/frontend/requirements.txt',
  ]) {
    expect(requirements).toContain('-r ' + file)
    expect(await Bun.file(resolve(root, file)).exists()).toBe(true)
  }
  expect(requirements).toContain('pytest==9.1.1')
  const pytest = await readFile(resolve(root, 'pytest.ini'), 'utf8')
  expect(pytest).toContain('testpaths = tests')
  expect(pytest).toContain('python_files = *_test.py')
  expect(pytest).toContain('--strict-config --strict-markers')
  const config = Bun.YAML.parse(
    await readFile(resolve(root, '.github/code-foundry.yml'), 'utf8')
  ) as Record<string, unknown>
  expect(config['required_capabilities']).toBe('format,lint,type_check,build,unit')
})

test('local and hosted portable validation share the complete application and Python command', async () => {
  const pkg = await Bun.file(resolve(root, 'package.json')).json()
  for (const command of [
    'check',
    'typecheck:browser',
    'format:python:check',
    'lint:python',
    'test:python',
    'qualify:typecheck',
  ]) {
    expect(pkg.scripts['check:portable'].split(' && ')).toContain('bun run ' + command)
  }
  for (const file of ['ci.yml', 'cef-runtime.yml', 'benchmarks.yml']) {
    const text = await readFile(resolve(root, '.github/workflows', file), 'utf8')
    const check = text.indexOf('bun run check:portable')
    expect(check, file).toBeGreaterThan(0)
    expect(text.slice(0, check), file).toContain('-r requirements.txt')
    expect(text.slice(0, check), file).toContain('actions/setup-python@')
    expect(text.slice(0, check), file).toContain('PYTHON=')
  }
  expect(pkg.scripts['check:ci']).toContain('code-foundry check --tier audit')
  expect(pkg.scripts.check).not.toContain('cargo')
})

test('required pull-request jobs report within five minutes', async () => {
  const jobs: Array<[string, string, number]> = [
    ['ci.yml', 'foundation', 15],
    ['qualification.yml', 'lifecycle', 12],
    ['development.yml', 'development', 8],
    ['kernel-counters.yml', 'kernel', 10],
    ['benchmarks.yml', 'portable', 10],
    ['benchmarks.yml', 'electron', 15],
    ['bun-pty.yml', 'pty', 10],
    ['m6-reload.yml', 'reload', 10],
    ['electrobun.yml', 'electrobun', 15],
    ['cef-typecheck.yml', 'check', 15],
  ]
  for (const [file, name, previousTimeout] of jobs) {
    const workflow = Bun.YAML.parse(
      await readFile(resolve(root, '.github/workflows', file), 'utf8')
    ) as { jobs: Record<string, { 'timeout-minutes': number | string }> }
    const timeout = workflow.jobs[name]!['timeout-minutes']
    expect(
      timeout === 5 || String(timeout).includes('&& 5 ||'),
      `${file}/${name} must cap pull-request execution at five minutes (previously ${previousTimeout})`
    ).toBe(true)
  }

  const api = Bun.YAML.parse(
    await readFile(resolve(root, '.github/workflows/cef-typecheck.yml'), 'utf8')
  ) as { on: { pull_request: Record<string, unknown> } }
  expect(api.on.pull_request).not.toHaveProperty('paths')

  const validation = Bun.YAML.parse(
    await readFile(resolve(root, '.github/workflows/validation.yml'), 'utf8')
  ) as {
    jobs: {
      mode: { 'timeout-minutes': number; steps: { id?: string; run?: string }[] }
      validation: { with: { mode: string } }
    }
  }
  expect(validation.jobs.mode['timeout-minutes']).toBe(5)
  expect(validation.jobs.validation.with.mode).toBe('${{ needs.mode.outputs.mode }}')
  expect(validation.jobs.mode.steps.some((step) => step.run?.includes('mode=fast'))).toBe(true)
  expect(
    validation.jobs.mode.steps.some((step) => step.run?.includes('validation release_diff'))
  ).toBe(true)
})

test('custom qualification jobs respect drafts and do not cancel manual runs when CI resumes', async () => {
  for (const file of [
    'benchmarks.yml',
    'development.yml',
    'electrobun.yml',
    'kernel-counters.yml',
    'qualification.yml',
    'cef-typecheck.yml',
  ]) {
    const text = await readFile(resolve(root, '.github/workflows', file), 'utf8')
    const workflow = Bun.YAML.parse(text) as {
      on: { pull_request: { types: string[] } }
      concurrency: Record<string, unknown>
      jobs: Record<string, { if: string }>
    }
    expect(workflow.on.pull_request.types, file).toContain('ready_for_review')
    expect(workflow.concurrency['cancel-in-progress'], file).toBe(
      "${{ github.event_name == 'pull_request' }}"
    )
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if, file).toStartWith("vars.CI_BILLING_PAUSED == 'false'")
      expect(job.if, file).toContain('github.event.pull_request.draft == false')
    }
    expect(text, file).not.toContain('if: always()')
    if (file !== 'cef-typecheck.yml') expect(text, file).toContain('actions/setup-python@')
  }
})

test('manual CEF qualification enforces native formatting, lint, and tests', async () => {
  const workflow = Bun.YAML.parse(
    await readFile(resolve(root, '.github/workflows/cef-runtime.yml'), 'utf8')
  ) as {
    jobs: Record<string, { steps: { run?: string }[] }>
  }
  const commands = workflow.jobs['manual-native']!.steps.map((step) => step.run ?? '').join('\n')
  expect(commands).toContain('--component clippy')
  expect(commands).toContain('cargo +1.91.0 fmt --manifest-path native/cef-host/Cargo.toml --check')
  expect(commands).toContain('cargo +1.91.0 clippy --locked')
  expect(commands).toContain('--features packaging -- -D warnings')
  expect(commands).toContain(
    'cargo +1.91.0 test --locked --manifest-path native/cef-host/Cargo.toml --lib'
  )
})
