import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSolid } from '../../scripts/solid-build.ts'

// The native long-session fixture, run headless against the owned protocol
// peer with fewer rounds. Native acknowledgement and host RSS need the real
// host; see the Native Linux workflow.
test('the Solid workspace long-session fixture restores its mounted ownership each round', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-solid-workspace-soak-'))
  try {
    const application = await buildSolid(
      resolve(import.meta.dir, '../native/solid-workspace-soak.tsx'),
      directory
    )
    const environment: Record<string, string | undefined> = {
      ...process.env,
      BUN_NATIVE_WORKSPACE_TEST_PEER: resolve(import.meta.dir, '../core/events-peer.ts'),
    }
    delete environment['BUN_NATIVE_HOST']
    const child = Bun.spawn([process.execPath, application], {
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
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
      scenario: 'solid-workspace-soak',
      rounds: 3,
      replies: 48,
      completedReplies: 24,
      cancelledReplies: 24,
      ignoredStaleCallbacks: 12,
      scheduledTimers: 276,
      final: {
        localWork: {
          disposed: true,
          pendingTimers: 0,
          activeReplies: 0,
          completedReplies: 24,
          cancelledReplies: 24,
        },
      },
    })
    expect(Object.values(report.final.application)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(report.samples).toHaveLength(4)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 40_000)
