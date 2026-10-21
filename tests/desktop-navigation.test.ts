import { afterAll, expect, test } from 'bun:test'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Import the exact generated host template, rather than duplicating its policy.
const directory = await mkdtemp(join(tmpdir(), 'bunly-fixture-policy-'))
const source = join(directory, 'host.ts')
await copyFile(new URL('../benchmarks/fixtures/desktop-edit/host.ts.txt', import.meta.url), source)
const host = (await import(pathToFileURL(source).href)) as {
  navigationAllowed(
    config: { origin: string; workbenchOrigin: string | null },
    url: unknown,
    isMainFrame: unknown
  ): boolean
}
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})
const config = { origin: 'http://127.0.0.1:50001', workbenchOrigin: 'http://127.0.0.1:50002' }

test('shared fixture is allowed only as a child frame, including its nested previews', () => {
  expect(host.navigationAllowed(config, config.origin + '/', true)).toBe(true)
  expect(host.navigationAllowed(config, config.origin + '/preflight', false)).toBe(true)
  expect(host.navigationAllowed(config, config.workbenchOrigin + '/browser/form', false)).toBe(true)
  expect(host.navigationAllowed(config, config.workbenchOrigin + '/', true)).toBe(false)
})
test('missing frame grant does not allow another loopback origin', () => {
  expect(
    host.navigationAllowed(
      { ...config, workbenchOrigin: null },
      config.workbenchOrigin + '/',
      false
    )
  ).toBe(false)
  expect(host.navigationAllowed(config, 'http://127.0.0.1:50003/', false)).toBe(false)
})
test('navigation policy rejects remote origins, credentials, protocols and missing event fields', () => {
  for (const target of [
    'https://example.test',
    'http://localhost:50002/',
    'file:///etc/passwd',
    'javascript:void(0)',
    'data:text/html,test',
    'http://user:password@127.0.0.1:50002/',
    '//127.0.0.1:50002/',
    'bad',
  ]) {
    expect(host.navigationAllowed(config, target, false)).toBe(false)
  }
  expect(host.navigationAllowed(config, config.workbenchOrigin + '/', undefined)).toBe(false)
  expect(host.navigationAllowed(config, { url: config.origin }, false)).toBe(false)
})
