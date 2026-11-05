import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dir, '../..')
// Every TypeScript/TSX block in these READMEs must typecheck as a complete module.
const readmes = [
  'packages/protocol/README.md',
  'packages/runtime/README.md',
  'packages/renderer/README.md',
  'packages/react/README.md',
  'packages/solid/README.md',
] as const

function snippets(path: string): { language: 'ts' | 'tsx'; source: string }[] {
  const text = readFileSync(join(repository, path), 'utf8')
  return [...text.matchAll(/^```(tsx?)\n([\s\S]*?)^```$/gm)].map((match) => ({
    language: match[1] as 'ts' | 'tsx',
    source: match[2]!,
  }))
}

// Snippets resolve workspace packages, so they are checked from an ignored repository directory.
const cache = join(repository, '.bun-native')
mkdirSync(cache, { recursive: true })
const directory = mkdtempSync(join(cache, 'readme-snippets-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('package README code snippets', () => {
  test('each listed README contains TypeScript examples', () => {
    for (const path of ['packages/react/README.md', 'packages/solid/README.md'])
      expect(snippets(path).length).toBeGreaterThan(0)
  })

  test('typecheck against the current workspace exports', () => {
    const files: string[] = []
    for (const path of readmes)
      snippets(path).forEach(({ language, source }, index) => {
        const name = `${path.split('/')[1]}-${index + 1}.${language}`
        // Each snippet is an isolated module, even when it declares no imports.
        writeFileSync(join(directory, name), source + '\nexport {}\n')
        files.push(name)
      })
    writeFileSync(
      join(directory, 'tsconfig.json'),
      // Illustrative snippets may declare a value without using it.
      JSON.stringify({
        extends: '../../tsconfig.json',
        compilerOptions: { noUnusedLocals: false, noUnusedParameters: false },
        include: files,
      })
    )
    const result = Bun.spawnSync(
      [process.execPath, '--check', '--tsconfig-override', join(directory, 'tsconfig.json')],
      { cwd: repository, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 }
    )
    const output = result.stdout.toString() + result.stderr.toString()
    expect({ exitCode: result.exitCode, output }).toMatchObject({ exitCode: 0 })
    expect(output).toContain('No type errors')
  })
})
