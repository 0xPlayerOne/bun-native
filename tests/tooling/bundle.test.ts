import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundleApplication } from '../../scripts/native/bundle.ts'

const repository = resolve(import.meta.dir, '../..')

function tracked(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z', 'scripts', 'experiments', 'benchmarks'], {
    cwd: repository,
    stdout: 'pipe',
  })
  return result.stdout
    .toString()
    .split('\0')
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
}

// One bundler configuration: CI fixtures and benchmarks must qualify the same
// application module bytes that `native dev` and `native build` produce.
test('every application bundle uses the shared bundler configuration', () => {
  const offenders: string[] = []
  for (const path of tracked()) {
    if (path === 'scripts/native/bundle.ts') continue
    const source = readFileSync(join(repository, path), 'utf8')
    // In-process bundles must take their options from bundleConfig. The package
    // validation build (scripts/build.ts) bundles the libraries, not an application.
    for (const match of source.matchAll(/Bun\.build\(\s*(\S*)/g))
      if (!match[1]!.startsWith('bundleConfig(') && path !== 'scripts/build.ts')
        offenders.push(`${path}: Bun.build(${match[1]}`)
    // A spawned `bun build` other than a JIT tool compile is a second configuration.
    for (const match of source.matchAll(/'build',\s*'(--[\w-]+)'/g))
      if (match[1] !== '--compile') offenders.push(`${path}: bun build ${match[1]}`)
  }
  expect(offenders).toEqual([])
})

test('the shared bundle is unminified and reports its module inputs relative to cwd', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-bundle-'))
  try {
    const { module, inputs } = await bundleApplication({
      framework: 'react',
      entry: join(repository, 'examples/react-counter/main.tsx'),
      outdir: directory,
      cwd: repository,
    })
    expect(module).toBe(join(directory, 'application.js'))
    expect(inputs).toContain('examples/react-counter/main.tsx')
    expect(inputs).toContain('packages/react/src/index.ts')
    expect(inputs.every((path) => !path.startsWith('/') && !path.includes('\\'))).toBe(true)
    // `// path` comments name modules relative to cwd; a minified bundle has none.
    expect(readFileSync(module, 'utf8')).toContain('// examples/react-counter/main.tsx')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
