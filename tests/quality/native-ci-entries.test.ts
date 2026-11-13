import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, shardEntries } from '../../scripts/quality/compile-aot-entries.ts'
import {
  ciCompileOnly,
  ciCompiles,
  isFixture,
  type CiPlatform,
  type FixtureName,
} from '../../scripts/quality/native-fixtures.ts'

const root = join(import.meta.dir, '..', '..')
const tool = join(root, 'scripts/quality/compile-aot-entries.ts')
type Step = { name?: string; if?: string; run?: string }

function steps(workflow: string): Step[] {
  const parsed = Bun.YAML.parse(
    readFileSync(join(root, '.github/workflows', workflow), 'utf8')
  ) as { jobs: { native: { steps: Step[] } } }
  return parsed.jobs.native.steps
}

/** The shards a step runs on, from its `matrix.shard` condition. */
function shardsOf(step: Step, all: readonly number[]): number[] {
  const condition = step.if ?? ''
  const only = /matrix\.shard == (\d)/.exec(condition)
  if (only) return [Number(only[1])]
  const not = /matrix\.shard != (\d)/.exec(condition)
  return not ? all.filter((shard) => shard !== Number(not[1])) : [...all]
}

/**
 * The fixtures a step's script names, directly or through its loop and
 * assignment variables (bash `for x in a b`, `x=a`, `x="$y-suffix"`, and
 * PowerShell `foreach ($x in @('a', 'b'))`, `$x = "$y-suffix"`).
 */
function stepEntries(run: string): Set<FixtureName> {
  const values = new Map<string, Set<string>>()
  const add = (name: string, value: string) =>
    values.set(name, new Set([...(values.get(name) ?? []), value]))
  for (const [, name, list] of run.matchAll(/for (\w+) in ([^;\n]+); do/g))
    for (const value of list!.trim().split(/\s+/)) add(name!, value)
  for (const [, name, list] of run.matchAll(/foreach \(\$(\w+) in @\(([^)]*)\)\)/g))
    for (const [, value] of list!.matchAll(/'([\w-]+)'/g)) add(name!, value!)
  for (const [, name, value] of run.matchAll(/(?:^|[\s;)])(\w+)=([\w-]+)(?=[\s;]|$)/gm))
    add(name!, value!)
  for (const [, name, base, suffix] of run.matchAll(/\$?(\w+) ?= ?"\$(\w+)(-[\w-]+)"/g))
    for (const value of values.get(base!) ?? []) add(name!, value + suffix)
  const resolve = (word: string) =>
    word.startsWith('$') ? [...(values.get(word.slice(1)) ?? [])] : [word]
  const names = new Set<FixtureName>()
  const patterns = [
    /--entry "?(\$?[\w-]+)"?/g,
    /\$NATIVE_EVIDENCE\/(\$?[\w-]+)-package/g,
    /NATIVE_EVIDENCE '([\w-]+)-package'/g,
  ]
  for (const pattern of patterns)
    for (const [, word] of run.matchAll(pattern))
      for (const name of resolve(word!)) if (isFixture(name)) names.add(name)
  if (run.includes('$NATIVE_EVIDENCE/package/native-window')) names.add('native-window')
  if (run.includes("NATIVE_EVIDENCE 'aot-package'")) names.add('platform-smoke')
  return names
}

const sorted = (names: Iterable<string>) => [...new Set(names)].sort()

test('the Linux shard compile lists are exactly what each shard runs', () => {
  const all = [1, 2, 3]
  for (const shard of all) {
    const inline = new Set<FixtureName>()
    const used = new Set<FixtureName>()
    for (const step of steps('native-linux.yml')) {
      if (!step.run || !shardsOf(step, all).includes(shard)) continue
      const names = stepEntries(step.run)
      for (const name of names) (step.run.includes('build-window.ts') ? inline : used).add(name)
    }
    const compiled = ciCompiles.linux[shard] ?? []
    const expected = sorted([...used].filter((name) => !inline.has(name)))
    expect({
      shard,
      compiled: sorted(compiled.filter((name) => !ciCompileOnly.has(name))),
    }).toEqual({
      shard,
      compiled: expected,
    })
    // Inline compiles never repeat a batched entry.
    expect({ shard, both: compiled.filter((name) => inline.has(name)) }).toEqual({
      shard,
      both: [],
    })
  }
  for (const name of ciCompileOnly) expect(ciCompiles.linux[2]).toContain(name)
})

test('the macOS and Windows shard compile lists are exactly what their shard-2 steps replay', () => {
  for (const [platform, os] of [
    ['darwin', 'macOS'],
    ['win32', 'Windows'],
  ] as [CiPlatform, string][]) {
    const replayed = new Set<FixtureName>()
    for (const step of steps('native-platforms.yml')) {
      if (!step.run?.includes('compile-aot-entries.ts --entry')) continue
      const condition = step.if ?? ''
      expect({ step: step.name, shard: shardsOf(step, [1, 2, 3]) }).toEqual({
        step: step.name,
        shard: [2],
      })
      const other = os === 'macOS' ? 'Windows' : 'macOS'
      // Exclusive to the other OS: `runner.os == 'X'` that is not one side of an `||`.
      const exclusive =
        condition.includes(`runner.os == '${other}'`) &&
        !condition.includes(`runner.os == '${other}' ||`) &&
        !condition.includes(`runner.os == '${os}'`)
      if (exclusive) continue
      for (const name of stepEntries(step.run)) replayed.add(name)
    }
    expect({ platform, compiled: sorted(ciCompiles[platform][2] ?? []) }).toEqual({
      platform,
      compiled: sorted(replayed),
    })
    expect(Object.keys(ciCompiles[platform])).toEqual(['2'])
  }
})

test('the variable-aware entry scan resolves loops and assignments in both shells', () => {
  expect(
    sorted(
      stepEntries(
        [
          'for framework in solid react; do',
          '  entry="$framework-workspace-terminal"',
          '  bash x --entry "$entry"',
          'done',
          'case "$s" in a) fixture=fault ;; b) fixture=layout ;; esac',
          'bash x --modes "$mode" --entry "$fixture"',
          'command=("$NATIVE_EVIDENCE/clipboard-package/clipboard")',
        ].join('\n')
      )
    )
  ).toEqual([
    'clipboard',
    'fault',
    'layout',
    'react-workspace-terminal',
    'solid-workspace-terminal',
  ])
  expect(
    sorted(
      stepEntries(
        [
          "foreach ($framework in @('solid', 'react')) {",
          '  $entry = "$framework-platform"',
          '  bun scripts/quality/compile-aot-entries.ts --entry $entry --outdir $package',
          '}',
        ].join('\n')
      )
    )
  ).toEqual(['react-platform', 'solid-platform'])
})

const work = mkdtempSync(join(tmpdir(), 'bun-native-aot-entries-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

// A stand-in build-window.ts under --source records each call and fails `fault`.
function fakeSource(): string {
  const source = mkdtempSync(join(work, 'source-'))
  mkdirSync(join(source, 'experiments/aot-gpui'), { recursive: true })
  writeFileSync(
    join(source, 'experiments/aot-gpui/build-window.ts'),
    [
      "import { appendFileSync, mkdirSync } from 'node:fs'",
      'const args = process.argv.slice(2)',
      'const value = (flag: string) => args[args.indexOf(flag) + 1]',
      "appendFileSync(process.env.CALLS!, JSON.stringify(args) + '\\n')",
      "mkdirSync(value('--outdir')!, { recursive: true })",
      "console.log('stdout of ' + value('--entry'))",
      "console.error('stderr of ' + value('--entry'))",
      "if (value('--entry') === 'fault') process.exit(3)",
    ].join('\n')
  )
  return source
}

/** One in-process invocation with its own environment and captured output. */
async function runTool(args: string[], env: Record<string, string>) {
  let out = ''
  let err = ''
  const code = await main(
    args,
    { ...process.env, ...env },
    { out: (text) => void (out += text), err: (text) => void (err += text) }
  )
  return { code, out, err }
}

/** The command line itself, whose fresh compile streams through its own stdout. */
function runCli(args: string[], env: Record<string, string>) {
  const result = Bun.spawnSync([process.execPath, tool, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

test('a batch compiles its shard in parallel, keeps going, and each step replays its own result', async () => {
  const source = fakeSource()
  const evidence = mkdtempSync(join(work, 'evidence-'))
  const temp = mkdtempSync(join(work, 'temp-'))
  const calls = join(work, 'calls-batch')
  writeFileSync(calls, '')
  const env = { NATIVE_EVIDENCE: evidence, RUNNER_TEMP: temp, CALLS: calls }
  const entries = shardEntries('linux', 1)
  const strict = await runTool(
    ['--platform', 'linux', '--shard', '1', '--jobs', '2', '--source', source, '--host', '/h'],
    env
  )
  expect(strict.code).toBe(1)
  expect(strict.err).toContain(`1 of ${entries.length} AOT entries failed`)
  // Every entry compiled once, whole log in its own group, with the inline arguments.
  const recorded = readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    sorted(recorded.map((args: string[]) => String(args[args.indexOf('--entry') + 1])))
  ).toEqual(sorted(entries))
  expect(recorded).toContainEqual([
    '--source',
    source,
    '--host',
    '/h',
    '--entry',
    'native-window',
    '--host-profile',
    'release',
    '--outdir',
    join(evidence, 'package'),
  ])
  expect(strict.out).toContain(
    '::group::AOT entry fault (exit 3)\nstdout of fault\nstderr of fault\n::endgroup::\n'
  )
  expect(strict.out).toContain('::group::AOT entry bridge (exit 0)\n')

  const replay = (entry: string, outdir: string) =>
    runTool(['--entry', entry, '--outdir', outdir, '--source', source, '--host', '/h'], env)
  const fault = await replay('fault', join(evidence, 'fault-package'))
  expect(fault.code).toBe(3)
  expect(fault.out).toContain('::group::AOT entry fault (exit 3)')
  expect((await replay('bridge', join(evidence, 'bridge-package'))).code).toBe(0)
  const before = readFileSync(calls, 'utf8')
  // An entry the batch did not compile into that directory is compiled now.
  const fresh = runCli(
    [
      '--entry',
      'bridge',
      '--outdir',
      join(evidence, 'elsewhere'),
      '--source',
      source,
      '--host',
      '/h',
    ],
    env
  )
  expect(fresh.code).toBe(0)
  expect(fresh.out).toContain('stdout of bridge')
  expect(readFileSync(calls, 'utf8').length).toBeGreaterThan(before.length)
  const inProcess = await replay('bridge', join(evidence, 'elsewhere-too'))
  expect(inProcess).toEqual({ code: 0, out: '', err: '' })
  expect(readFileSync(calls, 'utf8')).toContain(join(evidence, 'elsewhere-too'))

  const lenient = await runTool(
    [
      '--platform',
      'win32',
      '--shard',
      '2',
      '--jobs',
      '4',
      '--exclude=screen-reader,ime-platform',
      '--keep-going',
      '--source',
      source,
      '--host',
      '/h',
    ],
    { ...env, NATIVE_EVIDENCE: mkdtempSync(join(work, 'evidence-')) }
  )
  expect(lenient.code).toBe(0)
  expect(lenient.out).toContain('::group::AOT entry fault (exit 3)')
  expect(lenient.out).not.toContain('AOT entry screen-reader')
  expect(lenient.out).toContain('::group::AOT entry platform-smoke (exit 0)')
}, 60_000)

test('a shard with no batched entries compiles nothing', async () => {
  expect(shardEntries('linux', 3)).toEqual([])
  expect(shardEntries('darwin', 1)).toEqual([])
  const listed = runCli(['--platform', 'linux', '--shard', '1', '--list'], {})
  expect(listed.out.trim().split('\n')).toEqual(shardEntries('linux', 1))
  const excluded = await runTool(
    ['--platform', 'win32', '--shard', '2', '--exclude', 'screen-reader', '--list'],
    {}
  )
  expect(excluded.out.trim().split('\n')).toEqual(shardEntries('win32', 2, ['screen-reader']))
  expect(
    (
      await runTool(['--platform', 'linux', '--shard', '3', '--jobs', '2', '--host', '/h'], {
        NATIVE_EVIDENCE: work,
        RUNNER_TEMP: work,
      })
    ).code
  ).toBe(0)
})

test('the tool rejects incomplete or unknown input', async () => {
  await expect(
    runTool(['--entry', 'not-a-fixture', '--outdir', work, '--host', '/h'], {})
  ).rejects.toThrow('--entry needs')
  await expect(runTool(['--entry', 'bridge', '--host', '/h'], {})).rejects.toThrow('--entry needs')
  await expect(runTool(['--platform', 'beos', '--shard', '1', '--list'], {})).rejects.toThrow(
    '--platform must'
  )
  await expect(runTool(['--platform', 'linux', '--shard', 'x', '--list'], {})).rejects.toThrow(
    '--platform must'
  )
  await expect(
    runTool(['--platform', 'linux', '--shard', '1', '--jobs', '0', '--host', '/h'], {
      NATIVE_EVIDENCE: work,
    })
  ).rejects.toThrow('positive --jobs')
  await expect(
    runTool(['--platform', 'linux', '--shard', '1', '--host', '/h'], { NATIVE_EVIDENCE: '' })
  ).rejects.toThrow('Set NATIVE_EVIDENCE')
})
