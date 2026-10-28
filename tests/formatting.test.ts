import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const config = await Bun.file(join(root, '.oxfmtrc.json')).json()

async function fixture(run: (directory: string) => Promise<void>) {
  // macOS /var is an alias of /private/var; use one identity for cwd and config roots.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bunly-format-')))
  try {
    await writeFile(join(directory, '.oxfmtrc.json'), JSON.stringify(config))
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function format(directory: string, mode: '--check' | '--write', ...paths: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      'fmt',
      '--no-script',
      '--config',
      join(directory, '.oxfmtrc.json'),
      ...(mode === '--check' ? ['--check'] : []),
      ...paths,
    ],
    { cwd: directory, stdout: 'pipe', stderr: 'pipe', timeout: 10000 }
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, output: stdout + stderr }
}

test('normal checks enforce formatting before compilation without native toolchain requirements', async () => {
  const pkg = await Bun.file(join(root, 'package.json')).json()
  expect(pkg.scripts['format']).toBe('bun fmt --no-script .')
  expect(pkg.scripts['format:check']).toBe('bun fmt --no-script --check .')
  expect(pkg.scripts.check).toStartWith('bun run format:check && ')
  expect(pkg.scripts.check).not.toContain('cargo')
  expect(pkg.scripts.check).not.toContain('format:all')
  expect(config).toMatchObject({
    semi: false,
    singleQuote: true,
    tabWidth: 2,
    printWidth: 100,
    endOfLine: 'lf',
    sortImports: false,
    sortPackageJson: false,
    embeddedLanguageFormatting: 'off',
  })
  expect(config.ignorePatterns).not.toContain('packages/**')
  expect(config.ignorePatterns).not.toContain('tests/**')
})

test("Bun's formatter rejects drift, writes the expected style, then stays idempotent", async () => {
  await fixture(async (directory) => {
    const path = join(directory, 'example.ts')
    const original = 'export const example={title:"hello",values:[1,2]};\r\n'
    await writeFile(path, original)
    expect((await format(directory, '--check', path)).exitCode).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect((await format(directory, '--write', path)).exitCode).toBe(0)
    const formatted = await readFile(path, 'utf8')
    expect(formatted).toBe("export const example = { title: 'hello', values: [1, 2] }\n")
    expect((await format(directory, '--write', path)).exitCode).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(formatted)
  })
}, 15_000)

test('formatting leaves hash-bound evidence and local scratch byte-identical', async () => {
  await fixture(async (directory) => {
    const raw = '{ "sha256" : "fixture", "value":1 }\n'
    for (const name of ['evidence', '.bunly']) {
      await mkdir(join(directory, name))
      await writeFile(join(directory, name, 'raw.json'), raw)
    }
    await writeFile(join(directory, 'package.json'), '{"private":true,"name":"fixture"}')
    expect((await format(directory, '--write', '.')).exitCode).toBe(0)
    for (const name of ['evidence', '.bunly']) {
      const path = join(directory, name, 'raw.json')
      expect(await readFile(path, 'utf8')).toBe(raw)
    }
    expect((await format(directory, '--write', '.')).exitCode).toBe(0)
    for (const name of ['evidence', '.bunly']) {
      const path = join(directory, name, 'raw.json')
      expect(await readFile(path, 'utf8')).toBe(raw)
    }
  })
}, 15_000)

test('formatting does not reorder side-effect imports or rewrite embedded fixture strings', async () => {
  await fixture(async (directory) => {
    const path = join(directory, 'fixture.ts')
    const embedded = '<div   data-fixture=" exact ">  raw   bytes </div>'
    await writeFile(path, `import './z';import './a';export const html=/* HTML */\`${embedded}\`;`)
    expect((await format(directory, '--write', path)).exitCode).toBe(0)
    const formatted = await readFile(path, 'utf8')
    expect(formatted.indexOf("import './z'")).toBeLessThan(formatted.indexOf("import './a'"))
    expect(formatted).toContain(embedded)
    await writeFile(path, 'export const = ;')
    expect((await format(directory, '--check', path)).exitCode).not.toBe(0)
  })
}, 15_000)
