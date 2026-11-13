#!/usr/bin/env bun
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  ciCompiles,
  ciPackageDirectory,
  isFixture,
  type CiPlatform,
  type FixtureName,
} from './native-fixtures.ts'

/**
 * Compiles and inspects the AOT fixtures of one native CI shard in parallel,
 * each through `experiments/aot-gpui/build-window.ts` exactly as a suite step
 * compiled it inline, and replays one entry's result inside its suite step.
 *
 *   bun scripts/quality/compile-aot-entries.ts --platform linux --shard 2 --jobs 2 \
 *     --host <native host> [--exclude a,b] [--keep-going]
 *     Compiles the entries `ciCompiles` assigns to that shard into
 *     $NATIVE_EVIDENCE/<package directory>, JOBS at a time, and prints each
 *     log whole in its own group. Exits 1 when any entry failed, unless
 *     --keep-going leaves the failure to the entry's own suite step.
 *
 *   bun scripts/quality/compile-aot-entries.ts --entry NAME --outdir DIR --host <native host>
 *     Inside a suite step: prints the shard's recorded log of NAME and exits
 *     with its status. Without a record for that output directory (another
 *     shard, a skipped batch) it compiles NAME there now.
 *
 *   bun scripts/quality/compile-aot-entries.ts --platform linux --shard 1 --list
 *
 * Records live in $RUNNER_TEMP/aot-entries, outside the uploaded evidence.
 */

type Record_ = { entry: FixtureName; outdir: string; exitCode: number; log: string }

const platforms: readonly CiPlatform[] = ['linux', 'darwin', 'win32']

export function shardEntries(
  platform: CiPlatform,
  shard: number,
  exclude: readonly string[] = []
): FixtureName[] {
  return (ciCompiles[platform][shard] ?? []).filter((entry) => !exclude.includes(entry))
}

type Env = Record<string, string | undefined>
type Output = { out: (text: string) => void; err: (text: string) => void }

const processOutput: Output = {
  out: process.stdout.write.bind(process.stdout),
  err: process.stderr.write.bind(process.stderr),
}

function recordsDirectory(env: Env): string {
  return join(env.RUNNER_TEMP ?? tmpdir(), 'aot-entries')
}

/** One build-window run whose stdout and stderr share one log, as `> log 2>&1` did. */
async function compile(
  entry: FixtureName,
  outdir: string,
  options: { source: string; host: string; profile: string; log: string; env: Env }
): Promise<number> {
  const fd = openSync(options.log, 'w')
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(options.source, 'experiments/aot-gpui/build-window.ts'),
        '--source',
        options.source,
        '--host',
        options.host,
        '--entry',
        entry,
        '--host-profile',
        options.profile,
        '--outdir',
        outdir,
      ],
      { cwd: options.source, env: options.env, stdin: 'ignore', stdout: fd, stderr: fd }
    )
    return await child.exited
  } finally {
    closeSync(fd)
  }
}

function report(output: Output, entry: string, exitCode: number, log: string): void {
  output.out(
    `::group::AOT entry ${entry} (exit ${exitCode})\n${readFileSync(log, 'utf8')}::endgroup::\n`
  )
}

async function pool<T>(items: readonly T[], jobs: number, run: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!)
  })
  await Promise.all(workers)
}

/** Runs one invocation and returns its exit status; the CLI passes its own argv, env and streams. */
export async function main(
  args: string[],
  env: Env = process.env,
  output: Output = processOutput
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      platform: { type: 'string' },
      shard: { type: 'string' },
      jobs: { type: 'string', default: '1' },
      exclude: { type: 'string', default: '' },
      'keep-going': { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      entry: { type: 'string' },
      outdir: { type: 'string' },
      host: { type: 'string', default: env.BUN_NATIVE_HOST },
      source: { type: 'string', default: env.GITHUB_WORKSPACE ?? process.cwd() },
      'host-profile': { type: 'string', default: 'release' },
    },
    strict: true,
    allowPositionals: false,
  })
  const source = resolve(values.source)
  const records = recordsDirectory(env)

  if (values.entry !== undefined) {
    if (!isFixture(values.entry) || !values.outdir || !values.host)
      throw new Error('--entry needs a fixture name, --outdir and --host')
    const outdir = resolve(values.outdir)
    const path = join(records, `${values.entry}.json`)
    if (existsSync(path)) {
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record_
      if (resolve(record.outdir) === outdir) {
        report(output, record.entry, record.exitCode, record.log)
        return record.exitCode
      }
    }
    // stdout and stderr stream through, as the inline compile did.
    const child = Bun.spawn(
      [
        process.execPath,
        join(source, 'experiments/aot-gpui/build-window.ts'),
        '--entry',
        values.entry,
        '--source',
        source,
        '--host',
        values.host,
        '--host-profile',
        values['host-profile'],
        '--outdir',
        outdir,
      ],
      { cwd: source, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }
    )
    return await child.exited
  }

  const platform = values.platform as CiPlatform
  const shard = Number(values.shard)
  if (!platforms.includes(platform) || !Number.isInteger(shard))
    throw new Error('--platform must be linux, darwin or win32, with an integer --shard')
  const entries = shardEntries(
    platform,
    shard,
    values.exclude.split(',').filter((name) => name !== '')
  )
  if (values.list) {
    output.out(`${entries.join('\n')}\n`)
    return 0
  }
  const evidence = env.NATIVE_EVIDENCE
  const jobs = Number(values.jobs)
  if (!evidence || !values.host || !Number.isInteger(jobs) || jobs < 1)
    throw new Error('Set NATIVE_EVIDENCE, --host and a positive --jobs')
  mkdirSync(records, { recursive: true })
  let failed = 0
  await pool(entries, jobs, async (entry) => {
    const outdir = join(evidence, ciPackageDirectory(platform, entry))
    const log = join(records, `${entry}.log`)
    const exitCode = await compile(entry, outdir, {
      source,
      host: values.host!,
      profile: values['host-profile'],
      log,
      env,
    })
    // Each entry owns its outdir; logs are printed whole so parallel output never interleaves.
    report(output, entry, exitCode, log)
    writeFileSync(
      join(records, `${entry}.json`),
      JSON.stringify({ entry, outdir, exitCode, log } satisfies Record_)
    )
    if (exitCode !== 0) failed++
  })
  if (failed > 0 && !values['keep-going']) {
    output.err(`${failed} of ${entries.length} AOT entries failed\n`)
    return 1
  }
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
