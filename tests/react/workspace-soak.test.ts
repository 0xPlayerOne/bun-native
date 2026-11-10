import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

// The native long-session fixture, run headless against the owned overlay
// peer with fewer rounds. Native acknowledgement and host RSS need the real
// host; see the Native Linux workflow.
test('the React workspace long-session fixture restores its mounted ownership each round', async () => {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    BUN_NATIVE_WORKSPACE_TEST_PEER: resolve(import.meta.dir, '../core/overlay-peer.ts'),
  }
  delete environment['BUN_NATIVE_HOST']
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, '../native/react-workspace-soak.tsx')],
    { env: environment, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
  )
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exit, signal: child.signalCode, stderr }).toEqual({ exit: 0, signal: null, stderr: '' })
  const report = JSON.parse(stdout)
  expect(report).toMatchObject({
    status: 'passed',
    scenario: 'react-workspace-soak',
    rounds: 3,
    plans: 24,
    completedPlans: 12,
    stoppedPlans: 6,
    switchedPlans: 6,
    ignoredStaleCallbacks: 6,
    scheduledTimers: 138,
    cancelledTimers: 12,
    final: { pendingTimers: 0 },
  })
  expect(Object.values(report.final.application)).toEqual([0, 0, 0, 0, 0, 0, 0])
  expect(report.samples).toHaveLength(4)
}, 40_000)
