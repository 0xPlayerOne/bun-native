import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('Windows contributor artifacts statically include the CRT without changing other targets', async () => {
  const config = Bun.TOML.parse(
    await readFile(resolve(import.meta.dir, '../.cargo/config.toml'), 'utf8')
  ) as {
    target: Record<string, { rustflags: string[] }>
  }
  expect(Object.keys(config)).toEqual(['target'])
  expect(Object.keys(config.target)).toEqual(['x86_64-pc-windows-msvc'])
  expect(config.target['x86_64-pc-windows-msvc']?.rustflags).toEqual([
    '-C',
    'target-feature=+crt-static',
  ])
})
