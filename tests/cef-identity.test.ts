import { test, expect } from 'bun:test'
import { parseCefIdentity } from '../benchmarks/lib/cef-identity.ts'
const good = () => ({
  event: 'cef-binary-identity',
  schema: 1,
  sha256: 'a'.repeat(64),
  cefVersion: '123.4.5',
  cefCommitNumber: 6,
  chromiumVersion: '123.0.4567.89',
  fullVersion: null,
  source: 'exported-api',
  sandbox: 'unverified',
})
test('exported identity contains full Chromium version and binary digest', () => {
  expect(parseCefIdentity(good(), 'a'.repeat(64)).chromiumVersion).toBe('123.0.4567.89')
})
for (const patch of [
  { chromiumVersion: '123.0.0' },
  { source: 'user-agent' },
  { sandbox: 'verified' },
  { sha256: 'b'.repeat(64) },
  { cefCommitNumber: -1 },
  { fullVersion: '<unsafe>' },
  { cefVersion: '0.0.0' },
])
  test('reject malformed or mislabeled CEF identity ' + JSON.stringify(patch), () => {
    expect(() => parseCefIdentity({ ...good(), ...patch }, 'a'.repeat(64))).toThrow()
  })
