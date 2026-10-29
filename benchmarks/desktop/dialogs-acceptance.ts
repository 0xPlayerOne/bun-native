import assert from 'node:assert/strict'
import { nativeEvents } from '../lib/cef-acceptance.ts'
import { validateCommandObservation } from '../lib/observed-command.ts'
import {
  acceptDesktopEvidence,
  acceptDesktopObservation,
  desktopSourceSelectors,
} from './acceptance.ts'

export const DIALOGS_PROFILE = 'native-file-dialogs-v1'
export const dialogsSourceSelectors = [
  ...desktopSourceSelectors,
  'examples/file-dialogs',
  'examples/managed-desktop/document-readiness.ts',
] as const
const requiredSources = [
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
] as const
function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input))
  return input as Record<string, unknown>
}
export function acceptFileDialogsReceipt(input: unknown) {
  const receipt = record(input)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 4096)
  assert.deepEqual(Object.keys(receipt).sort(), [
    'assistiveTechnologyQualified',
    'checks',
    'event',
    'failure',
    'fileSelectionQualified',
    'final',
    'passed',
    'performanceEligible',
    'physicalInputQualified',
    'schema',
    'shutdown',
    'shutdowns',
    'status',
  ])
  assert.equal(receipt['event'], 'bunly.native.file-dialogs')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  assert.equal(receipt['shutdowns'], 1)
  assert.ok(receipt['status'] === 'executed' || receipt['status'] === 'unsupported')
  for (const key of [
    'physicalInputQualified',
    'assistiveTechnologyQualified',
    'fileSelectionQualified',
    'performanceEligible',
  ])
    assert.equal(receipt[key], false)
  const executed = receipt['status'] === 'executed'
  assert.deepEqual(receipt['checks'], {
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
  })
  assert.deepEqual(receipt['final'], {
    supported: executed,
    active: 0,
    visible: false,
    admissions: executed ? 6 : 0,
    callbacks: executed ? 6 : 0,
    selected: 0,
    cancelled: executed ? 3 : 0,
    failed: executed ? 3 : 0,
  })
  assert.deepEqual(receipt['shutdown'], receipt['final'])
  return Object.freeze({
    status: receipt['status'] as 'executed' | 'unsupported',
    callbacks: executed ? 6 : 0,
    nativeOwnershipReleased: true,
    physicalInputQualified: false,
    assistiveTechnologyQualified: false,
    fileSelectionQualified: false,
    performanceEligible: false,
  })
}
export function acceptFileDialogs(input: unknown) {
  const result = acceptDesktopObservation(
    input,
    'bunly.native.file-dialogs',
    acceptFileDialogsReceipt
  )
  const events = nativeEvents(validateCommandObservation(input))
  const shutdowns = events.filter((event) => event['event'] === 'bunly.host.dialog-shutdown')
  assert.equal(shutdowns.length, 1)
  assert.deepEqual(Object.keys(shutdowns[0]!).sort(), ['event', 'state'])
  const receipt = events.find((event) => event['event'] === 'bunly.native.file-dialogs')!
  assert.deepEqual(shutdowns[0]!['state'], receipt['final'])
  const processStop = events.findIndex(
    (event) =>
      event['event'] === 'bunly.host.shutdown-phase' &&
      event['phase'] === 'process-stop' &&
      event['state'] === 'start'
  )
  const backendExit = events.findIndex((event) => event['event'] === 'bunly.backend.exit')
  assert.ok(events.indexOf(shutdowns[0]!) < processStop)
  assert.ok(processStop < events.indexOf(receipt) && events.indexOf(receipt) < backendExit)
  return result
}
export function acceptDialogsReport(input: unknown) {
  const result = acceptDesktopEvidence(input, DIALOGS_PROFILE, requiredSources, acceptFileDialogs)
  assert.equal(
    result.status,
    record(input)['target'] === 'darwin-arm64' ? 'executed' : 'unsupported'
  )
  return result
}
