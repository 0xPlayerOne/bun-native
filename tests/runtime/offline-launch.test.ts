import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

// Offline qualification for #247 needs an empty network namespace. Linux
// provides one without privileges when user namespaces are enabled; elsewhere
// this case is reported as skipped, never as passed.
const isolated =
  process.platform === 'linux' &&
  Bun.which('unshare') !== null &&
  Bun.spawnSync(['unshare', '-rn', 'true'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0

test.if(isolated)('launches, round-trips and shuts down with no network', () => {
  const run = Bun.spawnSync(
    ['unshare', '-rn', process.execPath, resolve(import.meta.dir, 'offline-launch.ts')],
    { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 }
  )
  expect(run.stderr.toString()).toBe('')
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(run.stdout.toString())).toEqual({ external: [], opened: 'opened', exit: 0 })
})
