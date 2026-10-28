/** Pinned native-checker qualification, intentionally outside the ordinary edit loop. */
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dir, '..')
const reference = join(root, 'node_modules/typescript/bin/tsc')
const workspace = await mkdtemp(join(tmpdir(), 'bunly-typecheck-'))
const env = { ...process.env }
for (const key of ['AGENT', 'CLAUDECODE', 'REPL_ID', 'FORCE_COLOR']) delete env[key]
const results: { name: string; diagnostics: number; files?: number }[] = []

async function command(args: string[], cwd = workspace) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: { ...env, PWD: cwd },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, output: stdout + '\n' + stderr }
}
function diagnostics(output: string, cwd = workspace) {
  return [...output.matchAll(/^(.*?)\((\d+),(\d+)\): error TS(\d+):/gm)]
    .map((match) => {
      // Both printers may use different cwd-relative spelling; compare actual source identity.
      const candidates = [
        ...new Set(
          [cwd, root]
            .map((base) => resolve(base, match[1]!))
            .filter(existsSync)
            .map((path) => realpathSync(path))
        ),
      ]
      assert.equal(candidates.length, 1, 'Ambiguous diagnostic source: ' + match[1])
      return [candidates[0], Number(match[2]), Number(match[3]), Number(match[4])]
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) =>
        entry.isDirectory()
          ? (await files(join(directory, entry.name))).map((name) => entry.name + '/' + name)
          : [entry.name]
      )
    )
  )
    .flat()
    .sort()
}
async function compare(name: string, config: string, valid: boolean) {
  const before = await files(workspace)
  const native = await command(['--check', '--tsconfig-override', config])
  assert.deepEqual(await files(workspace), before, name + ': native checker emitted files')
  const tsc = await command([reference, '--noEmit', '--pretty', 'false', '-p', config])
  assert.equal(native.exitCode, valid ? 0 : 1, name + ': ' + native.output)
  assert.equal(tsc.exitCode, valid ? 0 : 1, name + ': ' + tsc.output)
  const actual = diagnostics(native.output)
  assert.deepEqual(actual, diagnostics(tsc.output), name + ': diagnostic mismatch')
  if (!valid) assert.ok(actual.length, name + ': failure lacked diagnostics')
  results.push({ name, diagnostics: actual.length })
}

try {
  assert.equal(Bun.version, '1.4.4', 'Requalify an upgraded Bun explicitly')
  const compiler = await Bun.file(join(root, 'node_modules/typescript/package.json')).json()
  assert.equal(process.versions['typescript'], compiler.version, 'Editor/reference checker drift')
  await Bun.write(join(workspace, 'package.json'), JSON.stringify({ private: true }))
  for (const name of ['tsconfig.json', 'tsconfig.browser.json']) {
    const config = join(root, name)
    await compare(name, config, true)
    const native = await command(['check', '--listFilesOnly', '-p', config])
    const tsc = await command([reference, '--listFilesOnly', '--pretty', 'false', '-p', config])
    assert.equal(native.exitCode, 0, native.output)
    assert.equal(tsc.exitCode, 0, tsc.output)
    const sources = (output: string) =>
      output
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter((path) => isAbsolute(path) && existsSync(path))
        // TypeScript emits forward slashes even when Windows' cwd uses backslashes.
        // Resolve actual files before containment checks; never compare path prefixes.
        .map((path) => relative(realpathSync(root), realpathSync(path)).split(sep))
        .filter(
          (parts) =>
            parts.length > 0 &&
            parts[0] !== '..' &&
            !isAbsolute(parts.join(sep)) &&
            !parts.includes('node_modules')
        )
        .map((parts) => parts.join('/'))
        .sort()
    const expected = sources(tsc.output)
    assert.ok(expected.length, 'Empty reference source set')
    assert.deepEqual(sources(native.output), expected, name + ': source coverage differs')
    if (process.platform === 'win32') {
      assert.deepEqual(
        sources(tsc.output.replaceAll('\\', '/')),
        expected,
        'Windows slash normalization changed coverage'
      )
      assert.deepEqual(
        sources(native.output.replaceAll('\\', '/')),
        expected,
        'Windows native slash normalization changed coverage'
      )
    }
    results.push({ name: name + '-coverage', diagnostics: 0, files: expected.length })
  }
  const cases: {
    name: string
    source: string
    browser?: boolean
    declarations?: string
    valid?: boolean
  }[] = [
    {
      name: 'valid-generics',
      source: 'export const id = <T>(v: T): T => v; export const n: number = id(1);',
      valid: true,
    },
    { name: 'assignment', source: 'export const n: number = "wrong";' },
    { name: 'unchecked-index', source: 'export const value: string = ([] as string[])[0];' },
    { name: 'exact-optional', source: 'export const v: { name?: string } = { name: undefined };' },
    {
      name: 'unknown-catch',
      source: 'export function f() { try { throw 1 } catch (e) { return e.message } }',
    },
    {
      name: 'override',
      source: 'class Base { value = 1 }; export class Child extends Base { value = 2 }',
    },
    { name: 'unused', source: 'const unused = 1; export {};' },
    {
      name: 'declarations',
      source: 'export const item: GeneratedItem = { value: "wrong" };',
      declarations: 'interface GeneratedItem { value: number }',
    },
    { name: 'browser-bun', source: 'export const runtime = Bun.version;', browser: true },
    { name: 'browser-process', source: 'export const runtime = process.pid;', browser: true },
    {
      name: 'browser-dom',
      source: 'export const root: HTMLElement = document.body;',
      browser: true,
      valid: true,
    },
    { name: 'syntax', source: 'export const broken: = ;' },
    { name: 'missing-import', source: 'export { value } from "./absent";' },
    {
      name: 'expect-error-valid',
      source: '// @ts-expect-error deliberate fixture\nexport const value: number = "wrong";',
      valid: true,
    },
    {
      name: 'expect-error-unused',
      source: '// @ts-expect-error must be rejected\nexport const value: number = 1;',
    },
  ]
  for (const item of cases) {
    const directory = join(workspace, item.name)
    await mkdir(directory)
    await Bun.write(join(directory, 'entry.ts'), item.source)
    if (item.declarations) await Bun.write(join(directory, 'generated.d.ts'), item.declarations)
    const config = join(directory, 'tsconfig.json')
    await Bun.write(
      config,
      JSON.stringify({
        extends: join(root, item.browser ? 'tsconfig.browser.json' : 'tsconfig.json'),
        compilerOptions: { types: [], noEmit: true },
        files: item.declarations ? ['entry.ts', 'generated.d.ts'] : ['entry.ts'],
        include: [],
        exclude: [],
      })
    )
    await compare(item.name, config, item.valid === true)
  }
  const excluded = join(workspace, 'excluded')
  await mkdir(excluded)
  await Bun.write(join(excluded, 'bad.ts'), 'export const value: number = "wrong";')
  await Bun.write(join(excluded, 'good.ts'), 'export const value = 1;')
  const config = join(excluded, 'tsconfig.json')
  await Bun.write(
    config,
    JSON.stringify({
      extends: join(root, 'tsconfig.json'),
      compilerOptions: { types: [] },
      include: ['*.ts'],
      exclude: ['bad.ts'],
    })
  )
  await compare('extends-and-exclude', config, true)
  await Bun.write(
    join(workspace, 'package.json'),
    JSON.stringify({
      scripts: { check: 'echo WRONG_CHECK_SCRIPT' },
    })
  )
  await compare('script-shadowing', join(workspace, 'assignment/tsconfig.json'), false)

  // Project-reference build mode has different semantics; qualify it independently.
  const graph = join(workspace, 'graph')
  for (const name of ['lib', 'app']) {
    await mkdir(join(graph, name), { recursive: true })
    await Bun.write(
      join(graph, name, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          types: [],
          composite: true,
          declaration: true,
          outDir: './dist',
          module: 'preserve',
          moduleResolution: 'bundler',
        },
        files: ['index.ts'],
        ...(name === 'app' ? { references: [{ path: '../lib' }] } : {}),
      })
    )
  }
  await Bun.write(join(graph, 'lib/index.ts'), 'export const value: number = 1;')
  await Bun.write(
    join(graph, 'app/index.ts'),
    'import { value } from "../lib/index"; export const result: string = value;'
  )
  await Bun.write(
    join(graph, 'tsconfig.json'),
    JSON.stringify({
      files: [],
      references: [{ path: './lib' }, { path: './app' }],
    })
  )
  await Bun.write(join(graph, 'package.json'), JSON.stringify({ private: true }))
  const before = await files(graph)
  const nativeGraph = await command(['check', '-b', 'tsconfig.json', '--no-pretty'], graph)
  assert.deepEqual(await files(graph), before, 'Build-mode checker emitted artifacts')
  const tscGraph = await command([reference, '-b', 'tsconfig.json', '--pretty', 'false'], graph)
  assert.equal(nativeGraph.exitCode, 1, nativeGraph.output)
  assert.notEqual(tscGraph.exitCode, 0, tscGraph.output)
  assert.deepEqual(diagnostics(nativeGraph.output, graph), diagnostics(tscGraph.output, graph))
  assert.ok(diagnostics(nativeGraph.output, graph).length)
  results.push({
    name: 'unbuilt-reference-graph',
    diagnostics: diagnostics(nativeGraph.output, graph).length,
  })
  for (const name of ['lib', 'app'])
    await rm(join(graph, name, 'dist'), { recursive: true, force: true })
  await Bun.write(
    join(graph, 'app/index.ts'),
    'import { value } from "../lib/index"; export const result: number = value;'
  )
  const clean = await files(graph)
  const repaired = await command(['check', '-b', 'tsconfig.json', '--no-pretty'], graph)
  assert.equal(repaired.exitCode, 0, repaired.output)
  assert.deepEqual(await files(graph), clean, 'Successful build-mode check emitted artifacts')
  const referenceRepaired = await command(
    [reference, '-b', 'tsconfig.json', '--pretty', 'false'],
    graph
  )
  assert.equal(referenceRepaired.exitCode, 0, referenceRepaired.output)
  results.push({ name: 'repaired-reference-graph', diagnostics: 0 })
  console.log(
    JSON.stringify(
      { schema: 1, bun: Bun.version, typescript: compiler.version, passed: true, cases: results },
      null,
      2
    )
  )
} finally {
  await rm(workspace, { recursive: true, force: true })
}
