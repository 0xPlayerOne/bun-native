import assert from 'node:assert/strict'
import { test, expect } from 'bun:test'
import { acceptBunPty } from '../benchmarks/pty/acceptance.ts'
import { qualifyBunPty } from '../benchmarks/pty/qualification.ts'

test('real pinned Bun PTY input, resize, output drain and bounded stream failures', async () => {
  const report = await qualifyBunPty()
  assert.equal(report.passed, true, JSON.stringify(report))
  acceptBunPty(report)
  for (const change of [
    { passed: false },
    { cases: report.cases.slice(1) },
    { cases: [...report.cases, report.cases[0]] },
  ])
    expect(() => acceptBunPty({ ...report, ...change })).toThrow()
  for (const change of [
    { consumedBytes: 0 },
    { controlWhilePaused: false },
    { reservationsReleased: false },
  ])
    expect(() =>
      acceptBunPty({
        ...report,
        cases: [{ ...report.cases[0], ...change }, ...report.cases.slice(1)],
      })
    ).toThrow()

  // Parser-policy regression only, not additional platform execution.
  const syntheticLinuxHangup = {
    ...report,
    target: 'linux-x64',
    cases: [
      {
        ...report.cases[0],
        terminalLifecycleCode: 1,
        cleanTerminalEof: false,
        terminalClosure: 'read-error-status-with-complete-known-fixture',
      },
      ...report.cases.slice(1),
    ],
  }
  acceptBunPty(syntheticLinuxHangup)
  expect(() => acceptBunPty({ ...syntheticLinuxHangup, target: 'darwin-arm64' })).toThrow()
  expect(() =>
    acceptBunPty({
      ...syntheticLinuxHangup,
      cases: [
        { ...syntheticLinuxHangup.cases[0], cleanTerminalEof: true },
        ...report.cases.slice(1),
      ],
    })
  ).toThrow()
  expect(report.passed).toBe(true)
  expect(report.cases.map((entry) => entry['name'])).toEqual(['ordered', 'cancelled', 'overloaded'])
}, 40_000)
