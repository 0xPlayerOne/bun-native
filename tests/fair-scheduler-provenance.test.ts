import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

test('native acceptance fingerprints the extracted lane and shared scheduler implementation', async () => {
  for (const name of [
    'qualify-cef-credentials.ts',
    'qualify-cef-development.ts',
    'qualify-cef-network.ts',
    'qualify-cef-terminals.ts',
    'qualify-cef-transports.ts',
    'qualify-cef-window-modes.ts',
  ]) {
    const source = await readFile(new URL('../scripts/' + name, import.meta.url), 'utf8')
    for (const module of ['cef-lane-transport.ts', 'fair-scheduler.ts'])
      expect(source.split("'packages/runtime/src/" + module + "'")).toHaveLength(2)
  }
})
