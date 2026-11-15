import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { CapturePixels } from './visible-pixels.ts'

type Identity = {
  ownerPID: number
  windowID: number
  region: readonly number[]
  windowSize: readonly number[]
}
type Match = {
  sha256: string
  windowReceivedUptime: number
  displayReceivedUptime: number
  windowDisplayTimeRaw: number
  displayDisplayTimeRaw: number
}

/** Hash exactly the BGR bytes used by the stream helper for a bounded PNG region. */
export function hashCaptureRegion(
  capture: CapturePixels,
  region: readonly [number, number, number, number]
) {
  const [x, y, width, height] = region
  assert(
    [capture.width, capture.height, x, y, width, height].every(Number.isSafeInteger) &&
      x >= 0 &&
      y >= 0 &&
      width > 0 &&
      height > 0 &&
      x + width <= capture.width &&
      y + height <= capture.height &&
      width * height <= 2_000_000,
    'Invalid stream screenshot region'
  )
  const bytes = new Uint8Array(width * height * 3)
  let offset = 0
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const rgb = capture.rgb(column, row)
      assert(
        Number.isSafeInteger(rgb) && rgb >= 0 && rgb <= 0xffffff,
        'Invalid stream screenshot pixel'
      )
      bytes[offset++] = rgb & 255
      bytes[offset++] = (rgb >> 8) & 255
      bytes[offset++] = (rgb >> 16) & 255
    }
  }
  return createHash('sha256').update(bytes).digest('hex')
}

function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Invalid stream evidence'
  )
  return value as Record<string, unknown>
}

function match(value: unknown): Match {
  const item = object(value)
  assert(
    typeof item['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(item['sha256']),
    'Invalid stream hash'
  )
  for (const key of [
    'windowReceivedUptime',
    'displayReceivedUptime',
    'windowDisplayTimeRaw',
    'displayDisplayTimeRaw',
  ]) {
    const number = item[key]
    assert(
      typeof number === 'number' && Number.isFinite(number) && number >= 0,
      'Invalid stream timestamp'
    )
  }
  return item as unknown as Match
}

/** Validate only the stream handshake. OCR, ownership and display guards remain separate. */
export function verifyStreamEvidence(ready: unknown, result: unknown, expected: Identity) {
  const readyRecord = object(ready)
  const resultRecord = object(result)
  assert.equal(readyRecord['status'], 'ready')
  assert.equal(resultRecord['status'], 'changed')
  const first = match(readyRecord['baseline'])
  const baseline = match(resultRecord['baseline'])
  const changed = object(resultRecord['changed'])
  const last = match(changed['match'])
  const counts = object(changed['counts'])
  assert.deepEqual(baseline, first, 'Stream baseline changed during handshake')
  assert.notEqual(last.sha256, first.sha256, 'Stream did not observe a changed label')
  assert(last.windowReceivedUptime >= first.windowReceivedUptime, 'Window frames are out of order')
  assert(
    last.displayReceivedUptime >= first.displayReceivedUptime,
    'Display frames are out of order'
  )
  assert.equal(resultRecord['ownerPID'], expected.ownerPID)
  assert.equal(resultRecord['windowID'], expected.windowID)
  assert.deepEqual(resultRecord['region'], expected.region)
  assert.deepEqual(resultRecord['windowSize'], expected.windowSize)
  for (const key of ['window', 'display'])
    assert(
      Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 2,
      'Insufficient stream frames'
    )
  assert(
    Number.isSafeInteger(counts['different']) && (counts['different'] as number) >= 0,
    'Invalid mismatch count'
  )
  return { baseline: first, changed: last, counts }
}
