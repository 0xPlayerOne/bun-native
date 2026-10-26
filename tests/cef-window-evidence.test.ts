import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

test('committed window evidence retains outcomes and raw hashes without local process identities', async () => {
  const source = await readFile(
    new URL('../evidence/m5-window-modes-local.json', import.meta.url),
    'utf8'
  )
  const evidence = JSON.parse(source)
  expect(evidence.passed).toBe(true)
  expect(evidence.modes.map((row: { mode: string }) => row.mode)).toEqual([
    'visible',
    'hidden',
    'shown',
    'minimized',
    'restored',
  ])
  expect(evidence.rawReport.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(evidence.redactions.omitted).toEqual(['pid', 'creationTime', 'kernelIdentity'])
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      expect(['pid', 'creationTime', 'kernelIdentity']).not.toContain(key)
      visit(item)
    }
  }
  visit(evidence)
})
