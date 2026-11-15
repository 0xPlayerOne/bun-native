import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  hashCaptureRegion,
  verifyStreamEvidence,
} from '../../benchmarks/electrobun/stream-evidence.ts'

const first = {
  sha256: 'a'.repeat(64),
  windowReceivedUptime: 1,
  displayReceivedUptime: 2,
  windowDisplayTimeRaw: 3,
  displayDisplayTimeRaw: 4,
}
const last = { ...first, sha256: 'b'.repeat(64), windowReceivedUptime: 5 }
const expected = { ownerPID: 42, windowID: 23, region: [12, 10, 240, 36], windowSize: [320, 180] }
const ready = { status: 'ready', baseline: first }
const result = {
  status: 'changed',
  baseline: first,
  ownerPID: 42,
  windowID: 23,
  region: [12, 10, 240, 36],
  windowSize: [320, 180],
  changed: { match: last, counts: { window: 2, display: 2, different: 1 } },
}

test('hashes the selected screenshot pixels in stream BGR order', () => {
  const capture = {
    width: 2,
    height: 2,
    rgb: (x: number, y: number) => [0x112233, 0x445566, 0x778899, 0xaabbcc][y * 2 + x]!,
  }
  const expectedHash = createHash('sha256')
    .update(Uint8Array.from([0x66, 0x55, 0x44, 0xcc, 0xbb, 0xaa]))
    .digest('hex')
  expect(hashCaptureRegion(capture, [1, 0, 1, 2])).toBe(expectedHash)
  expect(() => hashCaptureRegion(capture, [1, 0, 2, 2])).toThrow()
  expect(() => hashCaptureRegion({ ...capture, rgb: () => -1 }, [0, 0, 1, 1])).toThrow()
})

test('accepts a matched changed stream with the expected window identity', () => {
  expect(verifyStreamEvidence(ready, result, expected).changed.sha256).toBe(last.sha256)
})

test('rejects stale, malformed, mismatched or insufficient stream evidence', () => {
  expect(() => verifyStreamEvidence(ready, { ...result, ownerPID: 43 }, expected)).toThrow()
  expect(() => verifyStreamEvidence(ready, { ...result, region: [0, 0, 1, 1] }, expected)).toThrow()
  expect(() =>
    verifyStreamEvidence(ready, { ...result, windowSize: [320, 179] }, expected)
  ).toThrow()
  expect(() => verifyStreamEvidence(ready, { ...result, baseline: last }, expected)).toThrow()
  expect(() =>
    verifyStreamEvidence(
      ready,
      { ...result, changed: { ...result.changed, match: first } },
      expected
    )
  ).toThrow()
  expect(() =>
    verifyStreamEvidence(
      ready,
      {
        ...result,
        changed: { ...result.changed, counts: { window: 1, display: 2, different: 0 } },
      },
      expected
    )
  ).toThrow()
  expect(() =>
    verifyStreamEvidence(
      ready,
      { ...result, changed: { ...result.changed, match: { ...last, sha256: 'invalid' } } },
      expected
    )
  ).toThrow()
  expect(() =>
    verifyStreamEvidence(
      ready,
      { ...result, changed: { ...result.changed, match: { ...last, windowReceivedUptime: 0 } } },
      expected
    )
  ).toThrow()
})
