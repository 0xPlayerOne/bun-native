import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const oldRuntimeVersion = ['1.4', '3'].join('.')

describe('Bun runtime policy', () => {
  test('pins repository tooling, the package engine, and Bun itself to 1.4.4', async () => {
    const pkg = await Bun.file(resolve(root, 'package.json')).json()
    expect(readFileSync(resolve(root, '.bun-version'), 'utf8').trim()).toBe('1.4.4')
    expect(pkg.packageManager).toBe('bun@1.4.4')
    expect(pkg.engines.bun).toBe('1.4.4')
    expect(Bun.version).toBe('1.4.4')
  })

  test('redacts the prior Bun runtime version from tracked files and compressed evidence', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root })
      .toString()
      .split('\0')
      .filter(Boolean)
    const needle = Buffer.from(oldRuntimeVersion)
    for (const file of files) {
      const bytes = readFileSync(resolve(root, file))
      const content = file.endsWith('.gz') ? gunzipSync(bytes) : bytes
      expect(content.includes(needle), file).toBe(false)
    }
  })
})
