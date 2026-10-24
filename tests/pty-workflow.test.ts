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
