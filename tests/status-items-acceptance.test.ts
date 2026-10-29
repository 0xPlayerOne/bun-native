import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  STATUS_PROFILE,
  acceptStatusItemsReceipt,
  acceptStatusReport,
} from '../benchmarks/desktop/status-acceptance.ts'
import { desktopProfile } from '../benchmarks/desktop/profiles.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'

// Synthetic parser inputs only; never exported as native qualification evidence.
function receipt(executed = true) {
  return {
    event: 'bunly.native.status-items',
    schema: 1,
    passed: true,
    failure: null as string | null,
    status: executed ? 'executed' : 'unsupported',
    checks: executed
      ? {
          missingGrantDenied: true,
          oversizedRejected: true,
          forgedRejected: true,
          duplicateRejected: true,
          updated: true,
          explicitRemoval: true,
          managedJournalRetained: true,
          managedRemoval: true,
          viewCloseRemoval: true,
          quitRemoval: true,
        }
      : { capabilityUnavailable: true, createUnsupported: true, quitRemoval: true },
    callbacks: executed ? 2 : 0,
    shutdowns: 1,
    shutdown: {
      supported: executed,
      items: 0,
      delegates: 0,
      weakOwners: 0,
      created: executed ? 4 : 0,
      removed: executed ? 4 : 0,
      clicks: executed ? 2 : 0,
    },
    final: { items: 0, listeners: 0 },
    backendFinal: { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 },
    physicalInputQualified: false,
    trayMenusQualified: false,
    keepaliveQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  }
}
function report(target = 'darwin-arm64') {
  const value = receipt(target === 'darwin-arm64')
  const output = desktopReportFixture({
    receipt: value,
    acceptance: acceptStatusItemsReceipt(value),
    profile: STATUS_PROFILE,
    target,
    sourcePaths: [
      'packages/contracts/src/status-items.ts',
      'packages/runtime/src/cef-status-items.ts',
      'packages/runtime/src/managed-desktop.ts',
      'packages/runtime/src/managed-generations.ts',
      'native/cef-host/src/status_items.rs',
      'native/cef-host/src/status_items_macos.rs',
      'native/cef-host/src/capability_policy.rs',
      'native/cef-host/Cargo.toml',
      'examples/status-items/fixture.ts',
      'examples/status-items/public/index.html',
      'examples/managed-desktop/document-readiness.ts',
      'benchmarks/desktop/status-acceptance.ts',
    ],
  })
  const observation = output['observation'] as { stderr: string[]; postExitCleanup?: unknown }
  if (target === 'darwin-arm64')
    observation.postExitCleanup = {
      schema: 1,
      profile: 'macos-verified-code-sign-clone-v1',
      limitMs: 3000,
      elapsedMs: 100,
      observedClones: 1,
      passed: true,
      qualified: true,
      status: 'completed',
      cloneInventory: {
        prelaunchEntries: 0,
        entryLimit: 256,
        scope: 'new-names-after-prelaunch-snapshot',
      },
      helpers: [
        {
          pid: 123,
          creationTime: 1,
          role: 'code-sign-clone-cleanup',
          executableSha256: 'a'.repeat(64),
          ownership: 'observed-root-child-and-matching-clone-inode',
          processExited: true,
          cloneRemoved: true,
          completed: true,
        },
      ],
    }
  const application = observation.stderr.shift()!
  observation.stderr.unshift(
    JSON.stringify({ event: 'bunly.host.status-shutdown', state: value.shutdown })
  )
  observation.stderr.splice(2, 0, application)
  return output
}

test('status receipt requires four real removals, two callbacks and zero SDK/native owners', () => {
  assert.equal(acceptStatusItemsReceipt(receipt()).callbacks, 2)
  assert.equal(acceptStatusItemsReceipt(receipt(false)).status, 'unsupported')
  const changes: ((value: ReturnType<typeof receipt>) => void)[] = [
    (r) => {
      r.shutdown.items = 1
    },
    (r) => {
      r.shutdown.delegates = 1
    },
    (r) => {
      r.shutdown.weakOwners = 1
    },
    (r) => {
      r.shutdown.created = 3
    },
    (r) => {
      r.shutdown.removed = 3
    },
    (r) => {
      r.shutdown.clicks = 1
    },
    (r) => {
      r.callbacks = 1
    },
    (r) => {
      r.shutdowns = 2
    },
    (r) => {
      r.final.items = 1
    },
    (r) => {
      r.final.listeners = 1
    },
    (r) => {
      r.backendFinal.listenerErrors = 1
    },
    (r) => {
      r.backendFinal.views = 1
    },
    (r) => {
      r.checks.quitRemoval = false
    },
    (r) => {
      r.checks.managedJournalRetained = false
    },
    (r) => {
      r.physicalInputQualified = true
    },
    (r) => {
      r.trayMenusQualified = true
    },
    (r) => {
      r.keepaliveQualified = true
    },
    (r) => {
      r.assistiveTechnologyQualified = true
    },
    (r) => {
      r.performanceEligible = true
    },
    (r) => {
      r.passed = false
      r.failure = 'timeout'
    },
    (r) => {
      Object.assign(r, { unboundedNativePayload: '/private/fixture' })
    },
  ]
  for (const change of changes) {
    const value = receipt()
    change(value)
    assert.throws(() => acceptStatusItemsReceipt(value))
  }
  const unsupported = receipt(false)
  unsupported.shutdown.created = 1
  assert.throws(() => acceptStatusItemsReceipt(unsupported))
})

test('status reports bind exact source, platform and native removal before process-stop', () => {
  assert.equal(desktopProfile('status').profile, STATUS_PROFILE)
  for (const target of ['darwin-arm64', 'linux-x64', 'win32-x64'])
    assert.equal(
      acceptStatusReport(report(target)).status,
      target === 'darwin-arm64' ? 'executed' : 'unsupported'
    )
  for (const mutation of [
    'missing-native',
    'duplicate-native',
    'late-native',
    'early-app',
    'missing-source',
    'wrong-platform',
    'wrong-profile',
    'receipt-mismatch',
  ]) {
    const value = report()
    const observation = value['observation'] as { stderr: string[] }
    if (mutation === 'missing-native') observation.stderr.shift()
    if (mutation === 'duplicate-native') observation.stderr.unshift(observation.stderr[0]!)
    if (mutation === 'late-native') observation.stderr.splice(2, 0, observation.stderr.shift()!)
    if (mutation === 'early-app') observation.stderr.unshift(observation.stderr.splice(2, 1)[0]!)
    if (mutation === 'missing-source')
      for (const key of ['sourceHashes', 'sourceHashesAfter'])
        value[key] = (value[key] as { path: string }[]).filter(
          (entry) => entry.path !== 'native/cef-host/src/status_items_macos.rs'
        )
    if (mutation === 'wrong-platform') value['target'] = 'linux-x64'
    if (mutation === 'wrong-profile') value['profile'] = 'native-window-commands-v1'
    if (mutation === 'receipt-mismatch') {
      const native = JSON.parse(observation.stderr[0]!) as { state: { removed: number } }
      native.state.removed = 3
      observation.stderr[0] = JSON.stringify(native)
    }
    assert.throws(() => acceptStatusReport(value), mutation)
  }
})
