import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dir, '..')
test('lint excludes declared build outputs without excluding authored nested source', async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'bunly-lint-output-'))
  const config = await readFile(resolve(root, '.oxlintrc.json'), 'utf8')
  try {
    await writeFile(resolve(fixture, '.oxlintrc.json'), config)
    for (const directory of [
      'packages/check/src/dist',
      'packages/check/dist',
      'examples/check/dist',
    ]) {
      await mkdir(resolve(fixture, directory), { recursive: true })
    }
    await writeFile(resolve(fixture, 'packages/check/src/index.js'), 'export const valid = 1;\n')
    for (const output of ['packages/check/dist/index.js', 'examples/check/dist/index.js']) {
      await writeFile(resolve(fixture, output), 'debugger;\n')
    }
    const lint = () =>
      spawnSync(
        process.execPath,
        [
          resolve(root, 'node_modules/oxlint/bin/oxlint'),
          '--deny-warnings',
          'packages',
          'examples',
        ],
        { cwd: fixture, encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 }
      )
    const generated = lint()
    expect(generated.error).toBeUndefined()
    expect(generated.status, generated.stdout + generated.stderr).toBe(0)
    await writeFile(resolve(fixture, 'packages/check/src/dist/index.js'), 'debugger;\n')
    const authored = lint()
    expect(authored.error).toBeUndefined()
    expect(authored.status).toBe(1)
    expect(authored.stdout + authored.stderr).toContain('no-debugger')
    expect(authored.stdout + authored.stderr).toContain('src')
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
