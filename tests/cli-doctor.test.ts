import { fileURLToPath } from 'node:url'
import { test, expect } from 'bun:test'
import { CONTRACT_VERSION } from '../packages/contracts/src/core.ts'
import { BUILD_PROFILES, PROFILE_CAPABILITY_VERSION } from '../packages/contracts/src/profiles.ts'

test('doctor derives contract versions and separates framework support from installed qualification', async () => {
  const child = Bun.spawn([process.execPath, 'packages/cli/src/main.ts', 'doctor'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, text, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code).toBe(0)
  expect(error).toBe('')
  const report = JSON.parse(text)
  expect(report.contractVersion).toBe(CONTRACT_VERSION)
  expect(report.capabilityVersion).toBe(PROFILE_CAPABILITY_VERSION)
  expect(report.frameworkSupport).toEqual(BUILD_PROFILES.cef.adapters)
  expect(report.installedRuntime.status).toBe('not-probed')
  expect(report.qualification.releaseQualified).toBe(false)
  expect(text).not.toContain('M1 foundation')
  expect(text).not.toContain('not yet implemented')
})
