/** Validate a real first-install/updater transition without equating download and application success. */
import assert from 'node:assert/strict'
import { assertDesktopReplacement, type DesktopObservation } from './desktop-probe.ts'
export function verifyInstalledTransition(
  before: DesktopObservation,
  after: DesktopObservation,
  events: readonly Record<string, unknown>[],
  expectedBodyBytes: number
): void {
  if (!Number.isSafeInteger(expectedBodyBytes) || expectedBodyBytes < 1)
    throw new Error('Invalid expected update body size')
  assertDesktopReplacement(before, after, '0.0.2')
  assert.notEqual(before.host.pid, after.host.pid, 'Updater must start a new installed process')
  assert.equal(before.host.revision, '0.0.1')
  const required = [
    'started',
    'update-available',
    'download-verified',
    'apply-requested',
    'started',
  ]
  assert.deepEqual(
    events.map((e) => e['name']),
    required,
    'Unexpected, missing, duplicate, or failed updater transition'
  )
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!,
      current = i === events.length - 1 ? after : before
    assert.equal(event['revision'], current.host.revision)
    assert.equal(event['pid'], current.host.pid)
  }
  const download = events[2]!
  assert.equal(download['received'], expectedBodyBytes)
  assert.equal(download['total'], expectedBodyBytes)
}
