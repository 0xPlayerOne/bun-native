import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  SERVICES_PROFILE,
  acceptDesktopServicesReceipt,
  acceptServicesReport,
} from '../benchmarks/desktop/services-acceptance.ts'
import { desktopProfile, desktopReportProfile } from '../benchmarks/desktop/profiles.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'

// Synthetic parser inputs only; these are never execution evidence.
function receipt(executed = true) {
  return {
    event: 'bunly.native.desktop-services',
    schema: 1,
    passed: true,
    failure: null,
    ready: true,
    staleScopeRejected: true,
    eventOverflow: false,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
    clipboard: executed
      ? {
          status: 'executed',
          deniedRead: true,
          deniedWrite: true,
          deniedClear: true,
          initiallyEmpty: true,
          oversizedRejected: true,
          preAbortedReadRejected: true,
          unicodeRoundTrip: true,
          emptyStringDistinct: true,
          utf8ByteBoundary: true,
          clearRemovedFormats: true,
          restoredEmpty: true,
        }
      : { status: 'unsupported' },
    events: [
      { type: 'quit-requested' },
      { type: 'quitting', reason: 'requested' },
      { type: 'closed', outcome: 'orderly' },
    ],
    final: {
      phase: 'closed',
      quitRequested: true,
      quitReason: 'requested',
      outcome: 'orderly',
    },
    nativeFinal: {
      windows: 1,
      views: 0,
      sessions: 0,
      pending: 0,
      nativeDeliveryPackets: 0,
      nativeDeliveryBytes: 0,
      rpcIncomingBytes: 0,
      streamIncomingBytes: 0,
    },
  }
}

function report(executed: boolean) {
  const value = receipt(executed)
  const target = executed ? 'win32-x64' : 'linux-x64'
  const output = desktopReportFixture({
    receipt: value,
    acceptance: acceptDesktopServicesReceipt(value),
    profile: SERVICES_PROFILE,
    target,
    sourcePaths: [
      'packages/contracts/src/desktop.ts',
      'packages/runtime/src/application-lifecycle.ts',
      'native/cef-host/src/clipboard.rs',
      'examples/desktop-services/fixture.ts',
      'examples/desktop-services/clipboard-fixture.ts',
      'examples/managed-desktop/document-readiness.ts',
      'scripts/cef-desktop-services-precondition.ts',
      'benchmarks/desktop/services-acceptance.ts',
    ],
  })
  output['clipboardLaunch'] = executed
    ? { mode: 'disposable-github-hosted', target, explicitOptIn: true, runId: '123456' }
    : { mode: 'unsupported', target }
  const observation = output['observation'] as { environment: { runClass: string } }
  observation.environment.runClass = 'ci-smoke'
  return output
}

test('services receipt requires ordered lifecycle, authority, text boundaries and restoration', () => {
  assert.equal(acceptDesktopServicesReceipt(receipt()).clipboard, 'executed')
  assert.equal(acceptDesktopServicesReceipt(receipt(false)).clipboard, 'unsupported')
  for (const change of [
    (r: ReturnType<typeof receipt>) => {
      r.passed = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.events.reverse()
    },
    (r: ReturnType<typeof receipt>) => {
      r.events.pop()
    },
    (r: ReturnType<typeof receipt>) => {
      r.events.push(r.events[0]!)
    },
    (r: ReturnType<typeof receipt>) => {
      r.final.outcome = 'failed'
    },
    (r: ReturnType<typeof receipt>) => {
      r.nativeFinal.views = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.staleScopeRejected = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.eventOverflow = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.clipboard.restoredEmpty = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.clipboard.deniedWrite = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.clipboard.initiallyEmpty = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.clipboard.utf8ByteBoundary = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.performanceEligible = true
    },
  ]) {
    const value = receipt()
    change(value)
    assert.throws(() => acceptDesktopServicesReceipt(value))
  }
  assert.throws(() => acceptDesktopServicesReceipt({ ...receipt(), clipboardText: 'unexpected' }))
})

test('service evidence separates unsupported Linux from disposable hosted clipboard execution', () => {
  assert.equal(acceptServicesReport(report(true)).clipboard, 'executed')
  assert.equal(acceptServicesReport(report(false)).clipboard, 'unsupported')
  for (const change of [
    (r: Record<string, unknown>) => {
      delete r['clipboardLaunch']
    },
    (r: Record<string, unknown>) => {
      r['clipboardLaunch'] = { mode: 'unsupported', target: 'win32-x64' }
    },
    (r: Record<string, unknown>) => {
      ;(r['clipboardLaunch'] as Record<string, unknown>)['runId'] = 'invalid'
    },
    (r: Record<string, unknown>) => {
      ;(r['clipboardLaunch'] as Record<string, unknown>)['explicitOptIn'] = false
    },
    (r: Record<string, unknown>) => {
      const observation = r['observation'] as { environment: { runClass: string } }
      observation.environment.runClass = 'local-smoke'
    },
    (r: Record<string, unknown>) => {
      r['sourceHashes'] = []
    },
    (r: Record<string, unknown>) => {
      r['observerTimeoutMs'] = 46_000
    },
  ]) {
    const value = report(true)
    change(value)
    assert.throws(() => acceptServicesReport(value))
  }
  const linux = report(false)
  linux['clipboardLaunch'] = report(true)['clipboardLaunch']
  assert.throws(() => acceptServicesReport(linux))
})

test('service profile keeps a static renderer and its own historical source inventory', () => {
  const services = desktopProfile('services')
  assert.equal(services.profile, SERVICES_PROFILE)
  assert.equal(services.browserEntry, null)
  assert.ok(services.sourceSelectors.includes('examples/desktop-services'))
  assert.equal(desktopReportProfile(SERVICES_PROFILE), services)
  assert.throws(() => desktopProfile('unsupported'))
})

test('desktop Windows proof requires its implementation DLL and unchanged selected native binaries', () => {
  const missing = report(true)
  for (const key of [
    'inputArtifact',
    'inputArtifactAfter',
    'preparedArtifact',
    'preparedArtifactAfter',
  ]) {
    const artifact = missing[key] as { bytes: number; entries: { path: string; bytes: number }[] }
    const removed = artifact.entries.find((entry) => entry.path === 'bunly_host.dll')!
    artifact.bytes -= removed.bytes
    artifact.entries = artifact.entries.filter((entry) => entry !== removed)
  }
  for (const key of ['preparedMetadataBefore', 'preparedMetadataAfter'])
    missing[key] = (missing[key] as { path: string }[]).filter(
      (entry) => entry.path !== 'bunly_host.dll'
    )
  assert.throws(() => acceptServicesReport(missing))
  for (const path of ['bunly_host.exe', 'bunly_host.dll', 'resources/bun.exe', 'libcef.dll']) {
    const changed = report(true)
    for (const key of ['inputArtifact', 'inputArtifactAfter']) {
      const artifact = changed[key] as { entries: { path: string; sha256: string }[] }
      artifact.entries.find((entry) => entry.path === path)!.sha256 = 'f'.repeat(64)
    }
    if (path === 'bunly_host.exe') changed['inputHostSha256'] = 'f'.repeat(64)
    assert.throws(() => acceptServicesReport(changed), path)
  }
})
