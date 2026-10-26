import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('..', import.meta.url))
test('PTY qualification keeps pinned targets, standard-user Windows execution and bounded artifacts', async () => {
  const source = await readFile(join(root, '.github/workflows/bun-pty.yml'), 'utf8')
  const workflow = Bun.YAML.parse(source) as {
    jobs: {
      pty: { if: string; strategy: { matrix: { os: string[] } }; steps: Record<string, unknown>[] }
    }
  }
  expect(workflow.jobs.pty.strategy.matrix.os).toEqual(['ubuntu-24.04', 'macos-15', 'windows-2022'])
  expect(workflow.jobs.pty.if).toContain("vars.CI_BILLING_PAUSED == 'false'")
  expect(workflow.jobs.pty.if).toContain('draft == false')
  expect(source).toContain('bun-version: 1.4.3')
  expect(source).toContain('hosted-windows.ps1 -Suite pty')
  expect(source).toContain('path: .bunly/pty-evidence/qualification.json')
  expect(source).not.toContain('self-hosted')
  const runner = await readFile(join(root, 'scripts/hosted-windows.ps1'), 'utf8')
  expect(runner).toContain("if ($Suite -eq 'pty')")
  expect(runner).toContain('qualify-bun-pty.ts')
  expect(runner).toContain('must not be an administrator')
})

test('source scheduling regressions execute before real PTY qualification on every target', async () => {
  const source = await readFile(join(root, '.github/workflows/bun-pty.yml'), 'utf8')
  const workflow = Bun.YAML.parse(source) as {
    jobs: { pty: { steps: Record<string, unknown>[] } }
  }
  const steps = workflow.jobs.pty.steps
  const install = steps.findIndex(
    (step) => step['name'] === 'Install frozen application-side dependencies'
  )
  const regression = steps.findIndex(
    (step) => step['name'] === 'Validate bounded source scheduling'
  )
  expect(install).toBeGreaterThanOrEqual(0)
  expect(regression).toBeGreaterThan(install)
  expect(steps[regression]?.['run']).toBe(
    'bun test tests/fair-scheduler.test.ts tests/stream-source.test.ts tests/stream-source-fairness.test.ts'
  )
  expect(steps[regression]?.['if']).toBeUndefined()
  for (const name of [
    'Qualify actual Bun PTYs on Linux or macOS',
    'Qualify actual Bun PTYs as a Windows standard user',
  ])
    expect(steps.findIndex((step) => step['name'] === name)).toBeGreaterThan(regression)
})

test('runtime terminal service executes before PTY qualification and under the Windows standard user', async () => {
  const workflow = await readFile(join(root, '.github/workflows/bun-pty.yml'), 'utf8')
  const runner = await readFile(join(root, 'scripts/hosted-windows.ps1'), 'utf8')
  const tests = 'tests/terminal-service.test.ts tests/terminal-service-real.test.ts'
  expect(workflow).toContain('bun test ' + tests)
  const pty = runner.slice(
    runner.indexOf("if ($Suite -eq 'pty')"),
    runner.indexOf('exit $LASTEXITCODE')
  )
  expect(pty.indexOf('& $Bun test ' + tests)).toBeGreaterThanOrEqual(0)
  expect(pty.indexOf('& $Bun test ' + tests)).toBeLessThan(pty.indexOf('qualify-bun-pty.ts'))
  expect(pty).toContain(
    "if ($LASTEXITCODE -ne 0) { throw 'Standard-user terminal service regression failed' }"
  )
})

test('service supervisor qualification executes actual platform tests including standard-user Windows', async () => {
  const workflow = await readFile(join(root, '.github/workflows/bun-pty.yml'), 'utf8')
  const runner = await readFile(join(root, 'scripts/hosted-windows.ps1'), 'utf8')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  expect(manifest.scripts['qualify:services']).toBe(
    'bun test tests/service-supervisor.test.ts tests/service-supervisor-real.test.ts'
  )
  expect(workflow).toContain('bun run qualify:services')
  const pty = runner.slice(
    runner.indexOf("if ($Suite -eq 'pty')"),
    runner.indexOf('exit $LASTEXITCODE')
  )
  expect(pty).toContain('& $Bun run qualify:services')
  expect(pty).toContain(
    "if ($LASTEXITCODE -ne 0) { throw 'Standard-user service supervisor qualification failed' }"
  )
  expect(pty.indexOf('qualify:services')).toBeLessThan(pty.indexOf('qualify-bun-pty.ts'))
})
