import { test, expect } from 'bun:test'
import { ordinaryHttpsEvidence } from '../examples/cef/network-evidence.ts'
import type { NativeEvent } from '../packages/runtime/src/native-transport.ts'
const url = 'https://example.com/'
const loaded = (status: unknown): NativeEvent => ({
  v: 1,
  event: 'view.loaded',
  data: { url, status },
})

test('ordinary HTTPS evidence requires an exact native 2xx response', () => {
  const receipts: Readonly<Record<string, unknown>>[] = []
  for (const status of [200, 204, 299])
    expect(ordinaryHttpsEvidence(loaded(status), url, (r) => receipts.push(r))).toBe(true)
  expect(receipts.map((r) => r['status'])).toEqual([200, 204, 299])
  for (const status of [100, 199, 300, 403, 429, 500, 503, 599])
    expect(() => ordinaryHttpsEvidence(loaded(status), url, () => {})).toThrow(`HTTP ${status}`)
})

test('HTTPS failures retain bounded status or code, never raw errors or arbitrary URL content', () => {
  const receipts: Readonly<Record<string, unknown>>[] = []
  const record = (r: Readonly<Record<string, unknown>>) => receipts.push(r)
  expect(() => ordinaryHttpsEvidence(loaded(503), url, record)).toThrow('HTTP 503')
  expect(() =>
    ordinaryHttpsEvidence(
      { v: 1, event: 'view.load-error', data: { url, code: -202, message: 'private diagnostic' } },
      url,
      record
    )
  ).toThrow('(-202)')
  expect(receipts).toEqual([
    { event: 'bunly.network.https-observation', schema: 1, kind: 'loaded', status: 503 },
    { event: 'bunly.network.https-observation', schema: 1, kind: 'load-error', code: -202 },
  ])
  expect(JSON.stringify(receipts)).not.toContain('private')
  expect(JSON.stringify(receipts)).not.toContain(url)
})

test('malformed HTTP statuses and native codes never become successful HTTPS verification', () => {
  for (const status of [0, 600, 200.5, '200', NaN, Infinity, null, undefined])
    expect(() => ordinaryHttpsEvidence(loaded(status), url, () => {})).toThrow(
      'invalid native HTTP status'
    )
  for (const code of [0, 1, -1.2, '-202', NaN, undefined, 'private error']) {
    const receipts: Readonly<Record<string, unknown>>[] = []
    expect(() =>
      ordinaryHttpsEvidence({ v: 1, event: 'view.load-error', data: { url, code } }, url, (r) =>
        receipts.push(r)
      )
    ).toThrow('native load failed')
    expect(receipts[0]?.['code']).toBeNull()
  }
})

test('unrelated origins, paths and non-load events cannot satisfy or reject the HTTPS waiter', () => {
  const receipts: Readonly<Record<string, unknown>>[] = []
  for (const event of [
    { ...loaded(200), data: { url: 'https://example.com.evil/', status: 200 } },
    { ...loaded(200), data: { url: 'https://example.com/other', status: 200 } },
    { v: 1, event: 'view.navigating', data: { url } },
    { v: 1, event: 'policy.certificate-denied', data: { url: 'https://127.0.0.1/' } },
  ] as NativeEvent[])
    expect(ordinaryHttpsEvidence(event, url, (r) => receipts.push(r))).toBe(false)
  expect(receipts).toEqual([])
})
