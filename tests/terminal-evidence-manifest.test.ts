import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

test('retained terminal acceptance includes every pinned run and unchanged historical failure archive', async () => {
  const base = join(root, 'evidence/m5-terminal-acceptance')
  const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'))
  expect(manifest.schema).toBe(1)
  expect(manifest.releaseApproved).toBe(false)
  expect(manifest.performanceRatios).toBe(null)
  const expected = [
    ['native-functional', 'cef', 'windowed', 4, 0],
    ['native-repeated', 'cef', 'windowed', 20, 0],
    ['native-soak', 'cef', 'soak', 2, 0],
    ['electron-functional', 'electron', 'windowed', 4, 0],
    ['electron-repeated', 'electron', 'windowed', 20, 0],
    ['retained-native-drain-failure', 'cef', 'windowed', 3, 1],
    ['retained-stale-electron-preflight', 'electron', 'windowed', 0, 4],
  ]
  expect(
    manifest.runs.map((row: Record<string, unknown>) => [
      row.id,
      row.adapter,
      row.profile,
      row.accepted,
      row.failed,
    ])
  ).toEqual(expected)
  for (const row of manifest.runs) {
    expect(row.archive).toBe(`${row.id}.json.gz`)
    expect(row.source).toMatch(/^[a-f0-9]{40}$/)
    expect(row.passed).toBe(row.failed === 0)
    expect(row.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(row.expandedSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(row.expandedBytes).toBeGreaterThan(0)
    expect(row.expandedBytes).toBeLessThanOrEqual(256 * 1024 * 1024)
    const path = join(base, row.archive)
    const info = await stat(path)
    expect(info.isFile()).toBe(true)
    expect(info.size).toBe(row.archiveBytes)
    expect(info.size).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(sha(await readFile(path))).toBe(row.archiveSha256)
  }
  expect(Object.keys(manifest.historicalArchives).sort()).toEqual([
    'evidence/m5-terminal-load-followup/raw-evidence.json.gz',
    'evidence/m5-terminal-load/raw-evidence.json.gz',
  ])
  for (const [path, digest] of Object.entries(manifest.historicalArchives)) {
    if (typeof digest !== 'string') throw new TypeError('Invalid historical archive digest')
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(sha(await readFile(join(root, path)))).toBe(digest)
  }
}, 10000)
