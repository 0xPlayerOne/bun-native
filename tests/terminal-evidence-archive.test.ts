import { test, expect } from 'bun:test'
import { terminalArchiveReport } from '../benchmarks/lib/terminal-evidence-archive.ts'
const fingerprint = { path: 'packages/runtime/src/credential-proof.ts', sha256: 'a'.repeat(64) }
const fixture = () => ({
  schema: 1,
  classification: 'retained-profile-evidence-not-additional-execution',
  sourceFingerprintEncoding: 'path-sha256-records-v1',
  report: {
    passed: false,
    sourceHashes: [{ ...fingerprint }],
    sourceHashesAfter: [{ ...fingerprint }],
    trials: [{ passed: false }],
  },
})
test('explicit source-fingerprint records preserve exact digests and failed outcomes', () => {
  const input = fixture(),
    before = structuredClone(input)
  const output = terminalArchiveReport(input)
  expect(output.sourceHashes).toEqual({ [fingerprint.path]: fingerprint.sha256 })
  expect(output.sourceHashesAfter).toEqual(output.sourceHashes)
  expect(output.passed).toBe(false)
  expect(output.trials).toEqual([{ passed: false }])
  expect(input).toEqual(before)
})
test('archive fingerprints reject unknown encodings, duplicates, unsafe paths and changed sources', () => {
  expect(() =>
    terminalArchiveReport({ ...fixture(), sourceFingerprintEncoding: 'unknown' })
  ).toThrow()
  for (const rows of [
    [],
    Array.from({ length: 513 }, () => fingerprint),
    [fingerprint, fingerprint],
    [{ ...fingerprint, path: '../escape.ts' }],
    [{ ...fingerprint, path: '/absolute.ts' }],
    [{ ...fingerprint, path: 'relative/../escape.ts' }],
    [{ ...fingerprint, path: 'relative\\windows.ts' }],
    [{ ...fingerprint, path: '.' }],
    [{ ...fingerprint, sha256: 'claimed' }],
    [{ ...fingerprint, extra: true }],
  ]) {
    const input = fixture()
    expect(() =>
      terminalArchiveReport({ ...input, report: { ...input.report, sourceHashes: rows } })
    ).toThrow()
  }
  const changed = fixture()
  changed.report.sourceHashesAfter[0]!.sha256 = 'b'.repeat(64)
  expect(() => terminalArchiveReport(changed)).toThrow('Source changed')
})

test('root-level source manifests remain valid fingerprint paths', () => {
  const input = fixture()
  input.report.sourceHashes[0]!.path = 'package.json'
  input.report.sourceHashesAfter[0]!.path = 'package.json'
  expect(terminalArchiveReport(input).sourceHashes).toEqual({ 'package.json': fingerprint.sha256 })
})
