/**
 * Stage decomposition of the Solid `native dev --watch` compiler path (#372).
 *
 * Each case is a fresh Bun process that creates one Solid TypeScript checkout
 * template and repeats one distinct label edit per build through exactly one stage:
 *
 * - `full`: the production `bundleProject` path, as in `controller-allocator.ts`.
 * - `transform`: only the production `transformSolid` Babel call; no Bun.build or output.
 * - `bundle`: the production Bun.build settings with an `onLoad` plugin that returns
 *   the template transformed once at startup with the label substituted, so no
 *   Babel runs per edit.
 *
 * Every build's output is checked for its label. Cases run interleaved under both
 * `MIMALLOC_PURGE_DELAY` policies. No app, native host, forced collection or heap walk.
 *
 *   bun benchmarks/tooling/controller-solid-stages.ts [--builds 401] [--repeats 3]
 */
import { heapStats } from 'bun:jsc'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { bundleProject } from '../../scripts/native/build.ts'
import { bundleConfig } from '../../scripts/native/bundle.ts'
import { createProject, readProject, type Project } from '../../scripts/native/project.ts'
import { transformSolid } from '@bun-native/solid/build'

const repository = resolve(import.meta.dir, '../..')
const stages = ['full', 'transform', 'bundle'] as const
const policies = ['default', 'purge-0'] as const
type Stage = (typeof stages)[number]

function rss(): number {
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8'))
  if (!match) throw new Error('Linux /proc/self/status VmRSS is required')
  return Number(match[1]) * 1024
}

function positive(value: string, name: string, max: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
    throw new Error(`--${name} must be an integer from 1 to ${max}`)
  return parsed
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
}

/** The shared Solid bundler configuration, with precompiled module contents. */
async function bundleCompiled(project: Project, outdir: string, contents: string): Promise<string> {
  const result = await Bun.build(
    bundleConfig('solid', project.entry, outdir, [
      {
        name: 'precompiled-solid',
        setup(build) {
          build.onLoad({ filter: /\.[jt]sx$/ }, () => ({ contents, loader: 'ts' }))
        },
      },
    ])
  )
  if (!result.success) throw new AggregateError(result.logs, 'Precompiled Solid build failed')
  return join(outdir, 'application.js')
}

async function worker(stage: Stage, builds: number) {
  const cache = join(repository, '.bun-native')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'solid-stages-'))
  const previous = process.cwd()
  try {
    const project = await readProject(
      repository,
      await createProject(repository, join(root, 'app'), 'solid', 'typescript')
    )
    const original = await readFile(project.entry, 'utf8')
    if (!original.includes("'Clicks: '")) throw new Error('Template label changed')
    const compiled = transformSolid(original, project.entry)
    if (!compiled.includes("'Clicks: '")) throw new Error('Transformed template label changed')
    // Bundle paths are named relative to the cwd, as in `bundleProject`.
    process.chdir(project.directory)
    const durations: number[] = []
    let first = 0
    for (let index = 0; index < builds; index++) {
      const label = `Clicks ${String(index).padStart(6, '0')}: `
      const started = performance.now()
      let output: string
      if (stage === 'transform') {
        output = transformSolid(original.replace("'Clicks: '", `'${label}'`), project.entry)
        durations.push(performance.now() - started)
      } else {
        const outdir = await mkdtemp(join(root, 'generation-'))
        if (stage === 'full') {
          await writeFile(project.entry, original.replace("'Clicks: '", `'${label}'`))
          const bundle = await bundleProject(project, outdir)
          durations.push(performance.now() - started)
          output = await readFile(bundle, 'utf8')
        } else {
          const contents = compiled.replace("'Clicks: '", `'${label}'`)
          const bundle = await bundleCompiled(project, outdir, contents)
          durations.push(performance.now() - started)
          output = await readFile(bundle, 'utf8')
        }
        await rm(outdir, { recursive: true, force: true })
      }
      if (!output.includes(label)) throw new Error(`Build ${index} did not contain its edit`)
      if (index === 0) first = rss()
    }
    durations.sort((a, b) => a - b)
    const heap = heapStats()
    return {
      stage,
      policy: process.env['MIMALLOC_PURGE_DELAY'] === '0' ? 'purge-0' : 'default',
      builds,
      firstRssBytes: first,
      finalRssBytes: rss(),
      heapSizeBytes: heap.heapSize,
      heapCapacityBytes: heap.heapCapacity,
      medianMs: quantile(durations, 0.5),
      p95Ms: quantile(durations, 0.95),
    }
  } finally {
    process.chdir(previous)
    await rm(root, { recursive: true, force: true })
  }
}

async function supervise(builds: number, repeats: number): Promise<void> {
  console.log(JSON.stringify({ bun: Bun.revision, platform: process.platform, builds, repeats }))
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const policy of policies)
      for (const stage of stages) {
        const env: Record<string, string | undefined> = { ...process.env }
        delete env['MIMALLOC_PURGE_DELAY']
        if (policy === 'purge-0') env['MIMALLOC_PURGE_DELAY'] = '0'
        const child = Bun.spawn(
          [process.execPath, import.meta.path, '--worker', stage, '--builds', String(builds)],
          { env, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' }
        )
        const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
        if (code !== 0) throw new Error(`${stage}/${policy} worker exited ${code}`)
        console.log(JSON.stringify({ repeat, ...JSON.parse(output) }))
      }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      worker: { type: 'string' },
      builds: { type: 'string', default: '401' },
      repeats: { type: 'string', default: '3' },
    },
    strict: true,
  })
  const builds = positive(values.builds, 'builds', 5_000)
  if (values.worker === undefined) await supervise(builds, positive(values.repeats, 'repeats', 10))
  else if ((stages as readonly string[]).includes(values.worker))
    console.log(JSON.stringify(await worker(values.worker as Stage, builds)))
  else throw new Error(`--worker must be one of ${stages.join(', ')}`)
}
