import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { applicationLinkChecks } from '../examples/application-links/contract.ts'
import {
  acceptApplicationLinksReceipt,
  acceptApplicationLinksReport,
  LINKS_PROFILE,
} from '../benchmarks/desktop/links-acceptance.ts'
import { desktopProfile } from '../benchmarks/desktop/profiles.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'

// Synthetic parser regression inputs, never native qualification evidence.
function receipt() {
  return {
    event: 'bunly.native.application-links',
    schema: 1,
    passed: true,
    failure: null as string | null,
    checks: Object.fromEntries(applicationLinkChecks.map((check) => [check, true])),
    shutdowns: 1,
    shutdown: {
      readers: 0,
      queued: 0,
      bytes: 0,
      overflow: 0,
      startup: 2,
      macos: 0,
      rejected: 1,
      acknowledged: 2,
      delegates: 0,
    },
    final: { readers: 0 },
    backendFinal: { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 },
    osRegistrationQualified: false,
    liveOsDeliveryQualified: false,
    externalLaunchQualified: false,
    physicalInputQualified: false,
    performanceEligible: false,
  }
}
function report() {
  const value = receipt()
  const output = desktopReportFixture({
    receipt: value,
    acceptance: acceptApplicationLinksReceipt(value),
    profile: LINKS_PROFILE,
    target: 'linux-x64',
    sourcePaths: [
      'packages/contracts/src/application-links.ts',
      'packages/runtime/src/cef-application-links.ts',
      'packages/runtime/src/managed-desktop.ts',
      'packages/runtime/src/managed-generations.ts',
      'native/cef-host/src/application_links.rs',
      'native/cef-host/src/application_links_macos.rs',
      'native/cef-host/src/application_links_windows.rs',
      'native/cef-host/src/capability_policy.rs',
      'examples/application-links/fixture.ts',
      'examples/application-links/contract.ts',
      'examples/application-links/public/index.html',
      'examples/file-dialogs/readiness.ts',
      'benchmarks/desktop/links-acceptance.ts',
    ],
  })
  const observation = output['observation'] as { stderr: string[] }
  const application = observation.stderr.shift()!
  observation.stderr.unshift(
    JSON.stringify({ event: 'bunly.host.links-shutdown', state: value.shutdown })
  )
  observation.stderr.splice(2, 0, application)
  return output
}

test('link receipt requires exact routing, acknowledged replay and zero native/SDK owners', () => {
  assert.equal(acceptApplicationLinksReceipt(receipt()).acknowledged, 2)
  for (const key of ['readers', 'queued', 'bytes', 'overflow', 'macos', 'delegates'] as const) {
    const value = receipt()
    value.shutdown[key] = 1
    assert.throws(() => acceptApplicationLinksReceipt(value), key)
  }
  for (const key of ['startup', 'rejected', 'acknowledged'] as const) {
    const value = receipt()
    value.shutdown[key] = 0
    assert.throws(() => acceptApplicationLinksReceipt(value), key)
  }
  for (const check of applicationLinkChecks) {
    const value = receipt()
    value.checks[check] = false
    assert.throws(() => acceptApplicationLinksReceipt(value), check)
  }
  for (const flag of [
    'osRegistrationQualified',
    'liveOsDeliveryQualified',
    'externalLaunchQualified',
    'physicalInputQualified',
    'performanceEligible',
  ] as const) {
    const value = receipt()
    value[flag] = true
    assert.throws(() => acceptApplicationLinksReceipt(value), flag)
  }
  assert.throws(() =>
    acceptApplicationLinksReceipt({ ...receipt(), rawUrl: 'private-scheme://host/token' })
  )
})

test('link reports bind exact source and native cleanup before process stop', () => {
  assert.equal(desktopProfile('links').profile, LINKS_PROFILE)
  assert.equal(acceptApplicationLinksReport(report()).nativeOwners, 0)
  for (const mutation of [
    'missing-native',
    'duplicate-native',
    'late-native',
    'missing-source',
    'missing-navigation-helper',
    'mismatched-native',
  ]) {
    const value = report()
    const observation = value['observation'] as { stderr: string[] }
    if (mutation === 'missing-native') observation.stderr.shift()
    if (mutation === 'duplicate-native') observation.stderr.unshift(observation.stderr[0]!)
    if (mutation === 'late-native') observation.stderr.splice(2, 0, observation.stderr.shift()!)
    if (mutation === 'missing-navigation-helper')
      for (const key of ['sourceHashes', 'sourceHashesAfter'])
        value[key] = (value[key] as { path: string }[]).filter(
          (entry) => entry.path !== 'examples/file-dialogs/readiness.ts'
        )
    if (mutation === 'missing-source')
      for (const key of ['sourceHashes', 'sourceHashesAfter'])
        value[key] = (value[key] as { path: string }[]).filter(
          (entry) => entry.path !== 'native/cef-host/src/application_links.rs'
        )
    if (mutation === 'mismatched-native')
      observation.stderr[0] = JSON.stringify({
        event: 'bunly.host.links-shutdown',
        state: { ...receipt().shutdown, delegates: 1 },
      })
    assert.throws(() => acceptApplicationLinksReport(value), mutation)
  }
})

test('application link fixture bundles with linked sources and no native compiler', async () => {
  const result = await Bun.build({
    entrypoints: ['examples/application-links/fixture.ts'],
    target: 'bun',
    format: 'esm',
    sourcemap: 'external',
  })
  assert.equal(result.success, true, result.logs.join('\n'))
  assert.equal(result.outputs.length, 2)
})
