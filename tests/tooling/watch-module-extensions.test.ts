import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectFingerprint, rescanInput } from '../../scripts/native/inputs.ts'

const modules = [
  { extension: 'mjs', source: (value: string) => `export const message = '${value}'\n` },
  { extension: 'cjs', source: (value: string) => `module.exports = { message: '${value}' }\n` },
  { extension: 'mts', source: (value: string) => `export const message: string = '${value}'\n` },
  {
    extension: 'cts',
    source: (value: string) => `const message: string = '${value}'\nmodule.exports = { message }\n`,
  },
  {
    extension: 'jsonc',
    source: (value: string) => `// imported configuration\n{ "message": "${value}" }\n`,
  },
  { extension: 'toml', source: (value: string) => `message = '${value}'\n` },
] as const

for (const { extension, source } of modules) {
  test(`watch fingerprints include .${extension} dependencies consumed by the actual Bun bundler`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-module-inputs-'))
    try {
      const entry = join(directory, 'main.ts')
      const dependency = join(directory, `message.${extension}`)
      writeFileSync(
        entry,
        `import { message } from './message.${extension}'\nconsole.log(message)\n`
      )
      const absent = await projectFingerprint(directory)
      const before = `before_${extension}_source_edit`
      const after = `after_${extension}_source_edit`
      writeFileSync(dependency, source(before))
      const first = await projectFingerprint(directory)
      const bundle = async () => {
        const result = await Bun.build({
          entrypoints: [entry],
          target: 'bun',
          format: 'esm',
        })
        expect(result.success).toBe(true)
        expect(result.outputs).toHaveLength(1)
        return result.outputs[0]!.text()
      }
      expect(await bundle()).toContain(before)
      expect(rescanInput(`message.${extension}`)).toBe(true)
      writeFileSync(dependency, source(after))
      const updated = await bundle()
      expect(updated).toContain(after)
      expect(updated).not.toContain(before)
      const changed = await projectFingerprint(directory)
      // The old filter accepts this notification but ignores these bytes,
      // leaving a running application on the preceding successfully built code.
      expect(changed).not.toBe(first)
      expect(first).not.toBe(absent)
      writeFileSync(dependency, source(after))
      expect(await projectFingerprint(directory)).toBe(changed)
      mkdirSync(join(directory, 'dist'))
      writeFileSync(join(directory, 'dist', `ignored.${extension}`), source(before))
      writeFileSync(join(directory, 'README.md'), 'Documentation is not a source edit.\n')
      writeFileSync(join(directory, `message.${extension}.bak`), source(before))
      expect(await projectFingerprint(directory)).toBe(changed)
      const renamed = join(directory, `renamed.${extension}`)
      renameSync(dependency, renamed)
      expect(await projectFingerprint(directory)).not.toBe(changed)
      rmSync(renamed)
      expect(await projectFingerprint(directory)).toBe(absent)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
