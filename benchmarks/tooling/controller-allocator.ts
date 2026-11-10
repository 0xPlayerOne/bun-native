/**
 * Matched allocator control for the persistent `native dev --watch` compiler path.
 *
 * Each case is a fresh Bun process that creates one checkout template and calls the
 * production `bundleProject` path once per distinct source edit, removing every
 * output. Cases differ only in `MIMALLOC_PURGE_DELAY` (inherited default vs `0`).
 * No app, native host, forced collection or heap walk runs.
 *
 *   bun benchmarks/tooling/controller-allocator.ts [--builds 401] [--repeats 3]
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { bundleProject } from '../../scripts/native/build.ts'
import { createProject, readProject, type Framework } from '../../scripts/native/project.ts'

const repository = resolve(import.meta.dir, '../..')
const frameworks = ['solid', 'react'] as const satisfies readonly Framework[]
const policies = ['default', 'purge-0'] as const

type Summary = {
  framework: Framework
  policy: (typeof policies)[number]
  builds: number
  firstRssBytes: number
  finalRssBytes: number
  peakRssBytes: number
  medianBundleMs: number
  p95BundleMs: number
}

function rss(): number {
  // Linux reads VmRSS; macOS has no /proc, and Bun's rss there is the Mach task's
  // resident size, the same quantity.
  if (process.platform !== 'linux') return process.memoryUsage().rss
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

async function worker(framework: Framework, builds: number): Promise<Summary> {
  const cache = join(repository, '.bun-native')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'allocator-control-'))
  try {
    const project = await readProject(
      repository,
      await createProject(repository, join(root, 'app'), framework, 'typescript')
    )
    const original = await readFile(project.entry, 'utf8')
    if (!original.includes("'Clicks: '")) throw new Error('Template label changed')
    const durations: number[] = []
    let first = 0
    let peak = 0
    for (let index = 0; index < builds; index++) {
      const label = `Clicks ${String(index).padStart(6, '0')}: `
      await writeFile(project.entry, original.replace("'Clicks: '", `'${label}'`))
      const outdir = await mkdtemp(join(root, 'generation-'))
      const started = performance.now()
      const bundle = await bundleProject(project, outdir)
      durations.push(performance.now() - started)
      if (!(await readFile(bundle, 'utf8')).includes(label))
        throw new Error(`Build ${index} did not contain its edit`)
      await rm(outdir, { recursive: true, force: true })
      const resident = rss()
      if (index === 0) first = resident
      peak = Math.max(peak, resident)
    }
    durations.sort((a, b) => a - b)
    return {
      framework,
      policy: process.env['MIMALLOC_PURGE_DELAY'] === '0' ? 'purge-0' : 'default',
      builds,
      firstRssBytes: first,
      finalRssBytes: rss(),
      peakRssBytes: peak,
      medianBundleMs: quantile(durations, 0.5),
      p95BundleMs: quantile(durations, 0.95),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function supervise(builds: number, repeats: number): Promise<void> {
  console.log(JSON.stringify({ bun: Bun.revision, platform: process.platform, builds, repeats }))
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const framework of frameworks)
      for (const policy of policies) {
        const env: Record<string, string | undefined> = { ...process.env }
        delete env['MIMALLOC_PURGE_DELAY']
        if (policy === 'purge-0') env['MIMALLOC_PURGE_DELAY'] = '0'
        const child = Bun.spawn(
          [process.execPath, import.meta.path, '--worker', framework, '--builds', String(builds)],
          { env, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' }
        )
        const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
        if (code !== 0) throw new Error(`${framework}/${policy} worker exited ${code}`)
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
  else if (values.worker === 'solid' || values.worker === 'react')
    console.log(JSON.stringify(await worker(values.worker, builds)))
  else throw new Error('--worker must be solid or react')
}
