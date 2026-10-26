/** An explicit archive encoding identifies source-file digests, never credentials. */
import assert from 'node:assert/strict'
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function sourceMap(value: unknown): Record<string, string> {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 512)
  const entries = new Map<string, string>()
  for (const item of value) {
    const row = object(item)
    assert.deepEqual(Object.keys(row).sort(), ['path', 'sha256'])
    const path = row['path'],
      digest = row['sha256']
    assert.ok(typeof path === 'string' && path.length <= 256)
    assert.ok(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path))
    assert.ok(path.split('/').every((part) => part !== '.' && part !== '..'))
    assert.ok(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))
    assert.ok(!entries.has(path), 'Duplicated source fingerprint')
    entries.set(path, digest)
  }
  return Object.fromEntries(entries)
}
/** Reconstruct only the two known source maps. All report/observation validators
 * still execute afterward; this never manufactures a passed result or identity. */
export function terminalArchiveReport(value: unknown): Record<string, unknown> {
  const archive = object(value)
  assert.equal(archive['schema'], 1)
  assert.equal(archive['classification'], 'retained-profile-evidence-not-additional-execution')
  assert.equal(archive['sourceFingerprintEncoding'], 'path-sha256-records-v1')
  const report = object(archive['report'])
  const before = sourceMap(report['sourceHashes']),
    after = sourceMap(report['sourceHashesAfter'])
  assert.deepEqual(after, before, 'Source changed during the retained run')
  return { ...report, sourceHashes: before, sourceHashesAfter: after }
}
