import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundleApplication, moduleInputs } from '../../scripts/native/bundle.ts'
import {
  fixtureInventory,
  fixtures,
  type Fixture,
  type FixtureName,
} from '../../scripts/quality/native-fixtures.ts'

const repository = resolve(import.meta.dir, '../..')

test('every fixture entry exists', () => {
  for (const [name, fixture] of Object.entries(fixtures) as [FixtureName, Fixture][])
    expect({ name, exists: existsSync(join(repository, fixture.path)) }).toEqual({
      name,
      exists: true,
    })
})

// The hand-kept inventories missed imports (for example the counter examples'
// app.tsx and screen-reader-speech.ts); the metafile cannot.
test('a fixture inventory holds every module the bundler reads, plus its declared inputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-fixture-inventory-'))
  try {
    for (const name of ['solid', 'react', 'screen-reader', 'drag-drop'] as const) {
      const fixture: Fixture = fixtures[name]
      const entry = join(repository, fixture.path)
      const modules = fixture.framework
        ? (
            await bundleApplication({
              framework: fixture.framework,
              entry,
              outdir: join(directory, name),
              cwd: repository,
            })
          ).inputs
        : await moduleInputs(entry, repository)
      const inventory = (await fixtureInventory(repository, name, modules)).map(({ path }) => path)
      expect(inventory).toEqual([...inventory].sort())
      for (const module of modules.filter((path) => !path.startsWith('node_modules/')))
        expect(inventory).toContain(module)
      expect(inventory).toContain('bun.lock')
      expect(inventory).toContain('native/gpui-host/Cargo.toml')
      const expected = {
        solid: 'examples/solid-counter/app.tsx',
        react: 'examples/react-counter/app.tsx',
        'screen-reader': 'tests/native/screen-reader-speech.ts',
        'drag-drop': 'tests/native/macos-drag-source.m', // declared, never bundled
      }[name]
      expect(inventory).toContain(expected)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)
