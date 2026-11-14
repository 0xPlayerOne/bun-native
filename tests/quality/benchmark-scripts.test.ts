import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const root = resolve(import.meta.dir, '../..')
const EXPORT = join(root, 'benchmarks/comparison/export.ts')
const RUN = join(root, 'benchmarks/comparison/run.ts')
const ALLOCATOR = join(root, 'benchmarks/tooling/controller-allocator.ts')

function bun(argv: string[], env: Record<string, string | undefined> = {}) {
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...env }))
    if (value !== undefined) childEnv[key] = value
  const result = Bun.spawnSync([process.execPath, ...argv], {
    cwd: root,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function temporary() {
  return mkdtempSync(join(tmpdir(), 'bun-native-benchmark-scripts-'))
}

function readJsonLines(path: string) {
  return gunzipSync(readFileSync(path))
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

const stat = (median: number | null, low: number | null, high: number | null) => ({
  median,
  p95: median,
  medianInterval: { low, high },
})
const pooled = { median: 0.4, p95: 1.5, p99: 2 }

function comparison(inputLaunches: { name: string }[] | undefined) {
  return {
    status: 'passed',
    launches: [{ name: 'core-aot-1' }, { name: 'core-aot-2' }],
    ...(inputLaunches ? { inputLaunches } : {}),
    summary: {
      groups: {
        'core/aot': {
          measured: 2,
          failed: [],
          perLaunch: {
            spawnToViewMountedMs: stat(12.345, 10, 15),
            peakTreeRssBytes: stat(123_456_789, null, null),
          },
          pooledOperationSamplesMs: {
            signals: pooled,
            coalesced: pooled,
            keyedRotations: pooled,
            lifecycles: { median: null, p95: null, p99: null },
          },
        },
        'solid/aot': {
          measured: 1,
          failed: ['solid-aot-2'],
          perLaunch: {},
          pooledOperationSamplesMs: {
            signals: pooled,
            coalesced: pooled,
            keyedRotations: pooled,
            lifecycles: pooled,
          },
        },
      },
    },
    ...(inputLaunches
      ? {
          inputLatency: {
            groups: {
              'core/aot': {
                passed: 3,
                failed: [],
                commandStartToPaintObservedMs: stat(40, 30, 50),
              },
            },
          },
        }
      : {}),
    builds: {
      core: {
        moduleBuildWallMs: { fresh: 101.6, unchangedRebuild: 99.4 },
        aotCompileWallMs: 2_000.2,
        development: { bytes: 1_000 },
        aot: { bytes: 90_000_000 },
      },
    },
  }
}

function runDirectory(record: Record<string, unknown>) {
  const directory = temporary()
  const run = join(directory, 'run')
  mkdirSync(join(run, 'launches'), { recursive: true })
  writeFileSync(join(run, 'comparison.json'), JSON.stringify(record))
  writeFileSync(join(run, 'launches', 'core-aot-1.json'), JSON.stringify({ adapter: 'core' }))
  writeFileSync(join(run, 'launches', 'core-aot-1.stderr.log'), 'x'.repeat(5_000) + 'END')
  return { directory, run }
}

test('export keeps every child report, the stderr tail and the summary tables', () => {
  const { directory, run } = runDirectory(comparison(undefined))
  try {
    const destination = join(directory, 'nested', 'export')
    const result = bun([EXPORT, run, destination])
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(join(destination, 'comparison.json'), 'utf8'))).toEqual(
      comparison(undefined)
    )
    const [first, second] = readJsonLines(join(destination, 'launches.jsonl.gz'))
    expect(first.name).toBe('core-aot-1')
    expect(first.report).toEqual({ adapter: 'core' })
    expect(first.stderrTail).toHaveLength(4_000)
    expect(first.stderrTail.endsWith('END')).toBe(true)
    // A launch without a report or log is kept with explicit nulls.
    expect(second).toEqual({ name: 'core-aot-2', report: null, stderrTail: null })
    expect(existsSync(join(destination, 'input-launches.jsonl.gz'))).toBe(false)

    const lines = result.stdout.split('\n')
    expect(lines).toContain('| Metric (median [95% CI]) | core/aot | solid/aot |')
    expect(lines).toContain('| spawn to view mounted (ms) | 12.35 [10.00, 15.00] | n/a |')
    expect(lines).toContain('| peak tree RSS (MB) | 123.5 [n/a, n/a] | n/a |')
    expect(lines).toContain('| measured / failed launches | 2 / 0 | 1 / 1 |')
    expect(lines).toContain('| lifecycles p50 / p95 / p99 | n/a / n/a / n/a | 0.40 / 1.50 / 2.00 |')
    expect(lines).toContain('| signals p50 / p95 / p99 | 0.40 / 1.50 / 2.00 | 0.40 / 1.50 / 2.00 |')
    expect(lines).toContain('| core | 102 / 99 | 2000 | 1000 | 90000000 |')
    expect(result.stdout).not.toContain('XTest click to native paint')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('export adds input-latency launches and their table rows when present', () => {
  const inputs = [{ name: 'core-aot-input-1' }, { name: 'core-aot-input-2' }]
  const { directory, run } = runDirectory(comparison(inputs))
  try {
    mkdirSync(join(run, 'input', 'core-aot-input-1'), { recursive: true })
    writeFileSync(join(run, 'input', 'core-aot-input-1.json'), JSON.stringify({ child: 1 }))
    writeFileSync(
      join(run, 'input', 'core-aot-input-1', 'result.json'),
      JSON.stringify({ status: 'passed' })
    )
    const destination = join(directory, 'export')
    const result = bun([EXPORT, run, destination])
    expect(result.exitCode).toBe(0)
    expect(readJsonLines(join(destination, 'input-launches.jsonl.gz'))).toEqual([
      { name: 'core-aot-input-1', report: { child: 1 }, driver: { status: 'passed' } },
      { name: 'core-aot-input-2', report: null, driver: null },
    ])
    const lines = result.stdout.split('\n')
    expect(lines).toContain('| XTest click to native paint (ms) | 40.00 [30.00, 50.00] | n/a |')
    expect(lines).toContain('| input launches passed / failed | 3 / 0 | 0 / 0 |')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('export refuses relative paths and an existing destination', () => {
  const { directory, run } = runDirectory(comparison(undefined))
  try {
    for (const argv of [[], [run], ['relative/run', join(directory, 'a')], [run, 'relative/out']]) {
      const result = bun([EXPORT, ...argv])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('Usage: bun benchmarks/comparison/export.ts')
    }
    const existing = bun([EXPORT, run, directory])
    expect(existing.exitCode).not.toBe(0)
    expect(existing.stderr).toContain('Destination must not exist')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the comparison controller rejects invalid options before creating its output', () => {
  const directory = temporary()
  try {
    const host = join(directory, 'host')
    writeFileSync(host, '')
    const output = join(directory, 'out')
    const base = ['--host', host, '--host-profile', 'release', '--output', output]
    const cases: [string[], RegExp][] = [
      [['--host', 'relative', '--host-profile', 'release', '--output', output], /absolute paths/],
      [['--host', host, '--host-profile', 'release'], /absolute paths/],
      [['--host', host, '--host-profile', 'debug', '--output', output], /dev or release/],
      [[...base, '--adapters', 'core,core'], /distinct values from core,solid,react/],
      [[...base, '--adapters', 'core,vue'], /distinct values/],
      [[...base, '--trials', '31'], /trials must be an integer in 1\.\.30/],
      [[...base, '--trials', '2'], /trials must be at least 3/],
      [[...base, '--iterations', '15'], /multiple of 10/],
      [[...base, '--rows', '129'], /rows must be an integer in 1\.\.128/],
      [[...base, '--rss-interval-ms', '0'], /rss-interval-ms must be an integer/],
      [[...base, '--input-trials', '2'], /input-trials must be 0 or at least 3/],
      [[...base, '--input-trials', '31'], /input-trials must be an integer in 1\.\.30/],
      [[...base, '--input-trials', '3'], /requires the isolated Linux X11 session/],
      [[...base, '--phase-trials', '2'], /phase-trials requires core and at least 3 pairs/],
      [[...base, '--phase-trials', '11'], /phase-trials must be an integer in 1\.\.10/],
      [[...base, '--adapters', 'solid', '--phase-trials', '3'], /phase-trials requires core/],
      [['--host', directory, '--host-profile', 'dev', '--output', output], /existing file/],
      [[...base, '--unknown'], /Unknown option/],
    ]
    for (const [argv, message] of cases) {
      const result = bun([RUN, ...argv], { DISPLAY: undefined })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(message)
      expect(existsSync(output)).toBe(false)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the allocator control rejects out-of-range counts and unknown workers', () => {
  const cases: [string[], RegExp][] = [
    [['--builds', '0'], /--builds must be an integer from 1 to 5000/],
    [['--builds', '5001'], /--builds must be an integer from 1 to 5000/],
    [['--builds', '1.5'], /--builds must be an integer from 1 to 5000/],
    [['--repeats', '11'], /--repeats must be an integer from 1 to 10/],
    [['--worker', 'vue', '--builds', '1'], /--worker must be solid or react/],
    [['--unknown'], /Unknown option/],
  ]
  for (const [argv, message] of cases) {
    const result = bun([ALLOCATOR, ...argv])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(message)
  }
})

// The control reads VmRSS from /proc, so it only runs on Linux.
test.if(process.platform === 'linux')(
  'the allocator control interleaves fresh workers that differ only in purge delay',
  () => {
    // An inherited value must not leak into the default case.
    const result = bun([ALLOCATOR, '--builds', '2', '--repeats', '1'], {
      MIMALLOC_PURGE_DELAY: '7',
    })
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    const [header, ...records] = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(header).toEqual({ bun: Bun.revision, platform: 'linux', builds: 2, repeats: 1 })
    expect(records.map(({ framework, policy }) => `${framework}/${policy}`)).toEqual([
      'solid/default',
      'solid/purge-0',
      'react/default',
      'react/purge-0',
    ])
    for (const record of records) {
      expect(record.repeat).toBe(0)
      expect(record.builds).toBe(2)
      expect(record.firstRssBytes).toBeGreaterThan(0)
      expect(record.peakRssBytes).toBeGreaterThanOrEqual(record.firstRssBytes)
      expect(record.medianBundleMs).toBeGreaterThan(0)
      expect(record.p95BundleMs).toBeGreaterThanOrEqual(record.medianBundleMs)
    }
    // Each worker removes its checkout template.
    const cache = join(root, '.bun-native')
    const leftovers = existsSync(cache)
      ? [...new Bun.Glob('allocator-control-*').scanSync({ cwd: cache, onlyFiles: false })]
      : []
    expect(leftovers).toEqual([])
  }
)
