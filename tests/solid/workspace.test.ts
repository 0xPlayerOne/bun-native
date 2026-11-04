import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSolid } from '../../scripts/solid-build.ts'

test('the actual Solid workspace owns versioned drafts, native listeners and pending reply timers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-solid-workspace-'))
  try {
    const application = await buildSolid(
      resolve(import.meta.dir, 'workspace-contract.tsx'),
      directory
    )
    const child = Bun.spawn([process.execPath, application], {
      env: {
        ...process.env,
        BUN_NATIVE_WORKSPACE_TEST_PEER: resolve(import.meta.dir, '../core/events-peer.ts'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exit, signal: child.signalCode, stderr }).toEqual({
      exit: 0,
      signal: null,
      stderr: '',
    })
    const report = JSON.parse(stdout)
    expect(report).toMatchObject({
      status: 'passed',
      scope: 'headless public adapter and owned timers',
    })
    expect(report.ownership).toEqual({
      disposed: true,
      pendingTimers: 0,
      activeReplies: 0,
      completedReplies: 0,
      cancelledReplies: 3,
    })
    expect(Object.values(report.application)).toEqual([0, 0, 0, 0, 0, 0, 0])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
