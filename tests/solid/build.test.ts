import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dir, '../..')
const builder = join(repository, 'scripts/solid-build.ts')

function fixture(exercise: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-solid-build-'))
  try {
    exercise(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function run(args: string[]): string {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: repository,
    env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  })
  const output = result.stdout.toString() + result.stderr.toString()
  assert.equal(result.signalCode ?? null, null, output)
  assert.equal(result.exitCode, 0, output)
  return output
}

function sourcePaths(directory: string): string[] {
  const map: { sources: string[] } = JSON.parse(
    readFileSync(join(directory, 'application.js.map'), 'utf8')
  )
  return map.sources.map((path) => path.replaceAll('\\', '/'))
}

describe('Solid production module selection (actual pinned bundler, no native rendering)', () => {
  test('the builder selects production exports and constants independently of caller NODE_ENV', () => {
    fixture((directory) => {
      const dependency = join(directory, 'node_modules/framework')
      mkdirSync(dependency, { recursive: true })
      writeFileSync(
        join(dependency, 'package.json'),
        JSON.stringify({
          name: 'framework',
          type: 'module',
          exports: {
            browser: { development: { import: './dev.js' }, import: './production.js' },
            import: './production.js',
          },
        })
      )
      for (const selection of ['dev', 'production'])
        writeFileSync(
          join(dependency, selection + '.js'),
          `export const selected = ${JSON.stringify(selection)}; export const environment = process.env.NODE_ENV;\n`
        )
      const entry = join(directory, 'entry.ts')
      writeFileSync(
        entry,
        "import { selected, environment } from 'framework'; console.log(selected + ':' + environment)\n"
      )
      const output = join(directory, 'production')
      run([builder, entry, output])
      expect(run([join(output, 'application.js')])).toBe('production:production\n')
      expect(sourcePaths(output).some((path) => path.endsWith('/framework/production.js'))).toBe(
        true
      )
      expect(sourcePaths(output).some((path) => path.endsWith('/framework/dev.js'))).toBe(false)

      // An explicit production condition alone still keeps the default
      // development condition on this pin. This real negative control makes
      // the definition's role observable instead of asserting configuration text.
      const control = join(directory, 'control.mjs')
      const controlOutput = join(directory, 'condition-only')
      writeFileSync(
        control,
        `const result = await Bun.build({ entrypoints: [${JSON.stringify(entry)}], outdir: ${JSON.stringify(controlOutput)}, naming: 'application.js', target: 'bun', format: 'esm', conditions: ['browser', 'production'], sourcemap: 'external' }); if (!result.success) throw new AggregateError(result.logs);\n`
      )
      run([control])
      expect(run([join(controlOutput, 'application.js')])).toBe('dev:test\n')
      expect(sourcePaths(controlOutput).some((path) => path.endsWith('/framework/dev.js'))).toBe(
        true
      )
    })
  }, 20_000)

  test('the actual native JSX entry bundles production reactive and universal Solid modules', () => {
    fixture((directory) => {
      run([builder, join(repository, 'examples/solid-counter/main.tsx'), directory])
      const solid = sourcePaths(directory).filter((path) => path.includes('/solid-js/'))
      expect(solid.some((path) => path.endsWith('/solid-js/dist/solid.js'))).toBe(true)
      expect(solid.some((path) => path.endsWith('/solid-js/universal/dist/universal.js'))).toBe(
        true
      )
      expect(solid.some((path) => /\/(dev|server)\.(c?js)$/.test(path))).toBe(false)
    })
  }, 20_000)
})
