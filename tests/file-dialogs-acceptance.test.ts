import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  DIALOGS_PROFILE,
  acceptFileDialogsReceipt,
  acceptDialogsReport,
} from '../benchmarks/desktop/dialogs-acceptance.ts'
import { desktopProfile } from '../benchmarks/desktop/profiles.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'

// Synthetic parser inputs only; never exported as native qualification evidence.
function receipt(executed = true) {
  const state = {
    supported: executed,
    active: 0,
    visible: false,
    admissions: executed ? 6 : 0,
    callbacks: executed ? 6 : 0,
    selected: 0,
    cancelled: executed ? 3 : 0,
    failed: executed ? 3 : 0,
  }
  return {
    event: 'bunly.native.file-dialogs',
    schema: 1,
    passed: true,
    failure: null as string | null,
    status: executed ? 'executed' : 'unsupported',
    checks: {
      ...(executed
        ? {
            missingGrantDenied: true,
            openVisibleAndCancelled: true,
            saveVisibleAndCancelled: true,
            managedRetiredAfterNativeCompletion: true,
            navigationRevoked: true,
            viewCloseWaitedForNativeCompletion: true,
            quitWaitedForNativeCompletion: true,
          }
        : { capabilityUnavailable: true, openUnsupported: true, saveUnsupported: true }),
      directoryUnchanged: true,
      temporaryDirectoryRemoved: true,
    },
    final: state,
    shutdown: structuredClone(state),
    shutdowns: 1,
    physicalInputQualified: false,
    assistiveTechnologyQualified: false,
    fileSelectionQualified: false,
    performanceEligible: false,
  }
}
function report(target = 'darwin-arm64') {
  const value = receipt(target === 'darwin-arm64')
  const output = desktopReportFixture({
    receipt: value,
    acceptance: acceptFileDialogsReceipt(value),
    profile: DIALOGS_PROFILE,
    target,
    sourcePaths: [
      'packages/contracts/src/dialogs.ts',
      'packages/runtime/src/cef-dialogs.ts',
      'packages/runtime/src/managed-desktop.ts',
      'native/cef-host/src/dialogs.rs',
      'native/cef-host/src/dialogs_macos.rs',
      'native/cef-host/src/native_modal.rs',
      'native/cef-host/src/file_guards.rs',
      'examples/file-dialogs/fixture.ts',
      'examples/managed-desktop/document-readiness.ts',
      'benchmarks/desktop/dialogs-acceptance.ts',
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
    JSON.stringify({ event: 'bunly.host.dialog-shutdown', state: value.final })
  )
  observation.stderr.splice(2, 0, application)
  return output
}
test('dialog acceptance requires six actual callbacks and excludes file-selection or hardware claims', () => {
  assert.equal(acceptFileDialogsReceipt(receipt()).callbacks, 6)
  assert.equal(acceptFileDialogsReceipt(receipt(false)).status, 'unsupported')
  for (const change of [
    (r: ReturnType<typeof receipt>) => {
      r.final.active = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.final.visible = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.final.callbacks = 5
    },
    (r: ReturnType<typeof receipt>) => {
      r.final.selected = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.shutdown.callbacks = 5
    },
    (r: ReturnType<typeof receipt>) => {
      r.checks.directoryUnchanged = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.checks.temporaryDirectoryRemoved = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.physicalInputQualified = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.fileSelectionQualified = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.passed = false
      r.failure = 'timeout'
    },
    (r: ReturnType<typeof receipt>) => {
      r.shutdowns = 2
    },
  ]) {
    const value = receipt()
    change(value)
    assert.throws(() => acceptFileDialogsReceipt(value))
  }
})
test('dialog reports bind supported status, source inventory and native/app shutdown ordering', () => {
  assert.equal(desktopProfile('dialogs').profile, DIALOGS_PROFILE)
  for (const target of ['darwin-arm64', 'linux-x64', 'win32-x64'])
    assert.equal(
      acceptDialogsReport(report(target)).status,
      target === 'darwin-arm64' ? 'executed' : 'unsupported'
    )
  for (const mutation of ['missing-native', 'early-app', 'missing-source', 'wrong-platform']) {
    const value = report()
    const observation = value['observation'] as { stderr: string[] }
    if (mutation === 'missing-native') observation.stderr.shift()
    if (mutation === 'early-app') {
      const application = observation.stderr.splice(2, 1)[0]!
      observation.stderr.unshift(application)
    }
    if (mutation === 'missing-source') {
      for (const key of ['sourceHashes', 'sourceHashesAfter'])
        value[key] = (value[key] as { path: string }[]).filter(
          (entry) => entry.path !== 'native/cef-host/src/file_guards.rs'
        )
    }
    if (mutation === 'wrong-platform') value['target'] = 'linux-x64'
    assert.throws(() => acceptDialogsReport(value), mutation)
  }
})
