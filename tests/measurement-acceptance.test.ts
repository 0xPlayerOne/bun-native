import { expect, test } from 'bun:test'
import { createDesktopProbe } from '../benchmarks/lib/desktop-probe.ts'
import { runDesktopEdits, type DesktopEditAdapter } from '../benchmarks/lib/desktop-edits.ts'
const options = {
  revision: 'initial',
  state: 'state',
  counter: 1,
  framework: 'test',
  version: '1',
  html: '<p>test</p>',
  javascript: 'void 0;',
}
test('idle cannot be requested before document readiness or after disposal', async () => {
  const probe = await createDesktopProbe(options)
  expect(() => probe.requestIdle(1000)).toThrow()
  await probe.close()
  expect(() => probe.requestIdle(1000)).toThrow()
})
test('invalid idle configuration rejects before an adapter command runs', async () => {
  for (const idleObservationMs of [-1, 0, 0.5, 10001, NaN])
    await expect(
      runDesktopEdits({ kind: 'harness-test' } as DesktopEditAdapter, { idleObservationMs })
    ).rejects.toThrow('idle')
})
test('idle request is bounded, host-authenticated, and consumed once', async () => {
  const probe = await createDesktopProbe(options),
    c = probe.configuration
  const headers = { 'content-type': 'application/json', 'x-bunly-probe-token': c.hostToken }
  try {
    expect(
      (
        await fetch(c.origin + '/host', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            launch: c.launch,
            revision: 'initial',
            instance: 'one',
            state: 'state',
            counter: 1,
            pid: 1,
            framework: 'test',
            frameworkVersion: '1',
            runtimeVersion: '1',
            engineVersion: null,
            sandbox: 'unverified',
          }),
        })
      ).status
    ).toBe(202)
    expect(
      (
        await fetch(c.origin + '/renderer', {
          method: 'POST',
          headers: { ...headers, origin: c.origin, 'x-bunly-probe-token': c.rendererToken },
          body: JSON.stringify({
            launch: c.launch,
            revision: 'initial',
            document: 'doc',
            state: 'state',
            counter: 1,
            nativeGlobalsAbsent: true,
            frameOpportunities: 2,
          }),
        })
      ).status
    ).toBe(202)
    await probe.completion
    for (const invalid of [0, 249, 10001, NaN]) expect(() => probe.requestIdle(invalid)).toThrow()
    probe.requestIdle(500)
    expect(() => probe.requestIdle(500)).toThrow()
    expect(
      (await fetch(c.origin + '/command', { headers: { 'x-bunly-probe-token': c.rendererToken } }))
        .status
    ).toBe(403)
    expect(await (await fetch(c.origin + '/command', { headers })).json()).toEqual({
      command: 'observe-idle',
      milliseconds: 500,
    })
    probe.requestQuit()
    expect(await (await fetch(c.origin + '/command', { headers })).json()).toEqual({
      command: 'quit',
    })
  } finally {
    await probe.close()
  }
})

import { verifyInstalledTransition } from '../benchmarks/lib/installed-acceptance.ts'
import type { DesktopObservation } from '../benchmarks/lib/desktop-probe.ts'
function installed(revision: string, pid: number): DesktopObservation {
  const id = String(pid)
  return {
    host: {
      launch: id,
      revision,
      instance: id,
      state: 'state',
      counter: 1,
      pid,
      framework: 'Mirin',
      frameworkVersion: '1',
      runtimeVersion: '1',
      engineVersion: null,
      sandbox: 'unverified',
    },
    renderer: {
      launch: id,
      revision,
      document: id,
      state: 'state',
      counter: 1,
      nativeGlobalsAbsent: true,
      frameOpportunities: 2,
    },
  }
}
test('installed acceptance requires full ordered updater events, matching body size and a new process', () => {
  const first = installed('0.0.1', 1),
    second = installed('0.0.2', 2)
  const events = [
    'started',
    'update-available',
    'download-verified',
    'apply-requested',
    'started',
  ].map((name, i) => ({
    name,
    pid: i === 4 ? 2 : 1,
    revision: i === 4 ? '0.0.2' : '0.0.1',
    ...(i === 2 ? { received: 100, total: 100 } : {}),
  }))
  expect(() => verifyInstalledTransition(first, second, events, 100)).not.toThrow()
  expect(() => verifyInstalledTransition(first, second, events, 101)).toThrow()
  expect(() => verifyInstalledTransition(first, second, events.slice(1), 100)).toThrow()
  expect(() => verifyInstalledTransition(first, installed('0.0.2', 1), events, 100)).toThrow()
  expect(() =>
    verifyInstalledTransition(first, second, [...events, { name: 'failed' }], 100)
  ).toThrow()
})
