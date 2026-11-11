#!/usr/bin/env bun
// Launches the direct Rust GPUI baseline (#244) as fresh processes and records the
// process metrics the Bun Native comparison records: spawn to window/view/first
// paint, process wall time, CPU time, sampled peak process-tree RSS and the
// executable's bytes. Linux (inside the private display session), macOS and
// Windows (process tree and CPU time through ../comparison/windows-processes.ts).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { count } from '../solid/workload.ts'
import { reportProblem, summarizeBaseline, type BaselineLaunch, type Workload } from './summary.ts'
import { kernel32, ProcessTreeSampler, windowsLoad } from '../comparison/windows-processes.ts'

const { values } = parseArgs({
  options: {
    binary: { type: 'string' },
    output: { type: 'string' },
    trials: { type: 'string', default: '5' },
    iterations: { type: 'string', default: '1000' },
    rotations: { type: 'string', default: '1000' },
    mounts: { type: 'string', default: '100' },
    rows: { type: 'string', default: '32' },
    'rss-interval-ms': { type: 'string', default: '20' },
    // Extra mutation-to-paint samples per launch; they add frame-paced wall time.
    'paint-samples': { type: 'string', default: '0' },
  },
  strict: true,
  allowPositionals: false,
})
if (platform() !== 'linux' && platform() !== 'darwin' && platform() !== 'win32')
  throw new Error('The Rust GPUI baseline runner supports Linux, macOS and Windows')
const windowsApi = platform() === 'win32' ? await kernel32() : null
if (!values.binary || !isAbsolute(values.binary) || !values.output || !isAbsolute(values.output))
  throw new Error('--binary and --output require absolute paths')
if (existsSync(values.output)) throw new Error('--output must not exist yet')
const trials = count(values.trials, 'trials', 30)
if (trials < 3) throw new Error('trials must be at least 3 for a reported interval')
const workload: Workload = {
  iterations: count(values.iterations, 'iterations', 10_000),
  rotations: count(values.rotations, 'rotations', 10_000),
  mounts: count(values.mounts, 'mounts', 1_000),
  rows: count(values.rows, 'rows', 128),
  paintSamples:
    values['paint-samples'] === '0' ? 0 : count(values['paint-samples'], 'paint-samples', 1_000),
}
if (workload.iterations % 10 !== 0) throw new Error('iterations must be a multiple of 10')
const rssInterval = count(values['rss-interval-ms'], 'rss-interval-ms', 1_000)
const binary = values.binary
const output = values.output
mkdirSync(join(output, 'launches'), { recursive: true })

function optional(argv: string[]) {
  try {
    const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 })
    return result.exitCode === 0 ? result.stdout.toString().trim() : null
  } catch {
    return null
  }
}
function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** pid -> [parent pid, resident bytes] from one /proc walk or one `ps` snapshot. */
function processTable() {
  const table = new Map<number, [number, number]>()
  if (platform() === 'darwin') {
    const listing = optional(['ps', '-axo', 'pid=,ppid=,rss=']) ?? ''
    for (const line of listing.split('\n')) {
      const [pid, parent, kib] = line.trim().split(/\s+/).map(Number)
      if (pid !== undefined && parent !== undefined && kib !== undefined && !Number.isNaN(kib))
        table.set(pid, [parent, kib * 1024])
    }
    return table
  }
  const page = 4096
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      const pages = Number(readFileSync(`/proc/${entry}/statm`, 'utf8').split(' ')[1])
      table.set(Number(entry), [parent, pages * page])
    } catch {
      // Exited between listing and reading.
    }
  }
  return table
}
function treeRss(root: number) {
  const table = processTable()
  const tree = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, [parent]] of table)
      if (!tree.has(pid) && tree.has(parent)) {
        tree.add(pid)
        grew = true
      }
  }
  let total = 0
  for (const pid of tree) total += table.get(pid)?.[1] ?? 0
  return total
}

async function launch(name: string, first: boolean): Promise<BaselineLaunch> {
  const reportPath = join(output, 'launches', `${name}.json`)
  const spawnEpochMs = Date.now()
  const started = performance.now()
  const child = Bun.spawn(
    [
      binary,
      '--output',
      reportPath,
      ...['iterations', 'rotations', 'mounts', 'rows'].flatMap((key) => [
        `--${key}`,
        String(workload[key as keyof Workload]),
      ]),
      '--paint-samples',
      String(workload.paintSamples),
    ],
    {
      stdout: Bun.file(join(output, 'launches', `${name}.stdout.log`)),
      stderr: Bun.file(join(output, 'launches', `${name}.stderr.log`)),
    }
  )
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  let exited = false
  void child.exited.then(() => (exited = true))
  let peak = 0
  let samples = 0
  let windowsCpu: { cpuUserMs: number; cpuSystemMs: number } | null = null
  if (windowsApi) {
    // Working sets through held handles; final CPU time of every observed member.
    let sampler: ProcessTreeSampler | null = null
    try {
      sampler = new ProcessTreeSampler(windowsApi, child.pid)
    } catch {
      // The process exited before it could be opened; report nulls.
    }
    try {
      while (sampler && !exited) {
        const rss = sampler.sample().total
        if (rss > 0) {
          samples++
          peak = Math.max(peak, rss)
        }
        await Promise.race([Bun.sleep(rssInterval), child.exited])
      }
      await child.exited
      windowsCpu = sampler?.cpu() ?? null
    } finally {
      sampler?.close()
    }
  }
  while (!windowsApi && !exited) {
    const rss = treeRss(child.pid)
    if (rss > 0) {
      samples++
      peak = Math.max(peak, rss)
    }
    await Promise.race([Bun.sleep(rssInterval), child.exited])
  }
  const exitCode = await child.exited
  clearTimeout(timer)
  const wallMs = performance.now() - started
  const usage = windowsApi ? undefined : child.resourceUsage()
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
  const problem = exitCode !== 0 ? `exit ${exitCode}` : reportProblem(report, workload)
  console.log(JSON.stringify({ name, status: problem ? 'failed' : 'passed', error: problem }))
  return {
    name,
    first,
    status: problem ? 'failed' : 'passed',
    error: problem,
    exitCode,
    spawnEpochMs,
    wallMs,
    cpuUserMs: usage ? Number(usage.cpuTime.user) / 1_000 : (windowsCpu?.cpuUserMs ?? null),
    cpuSystemMs: usage ? Number(usage.cpuTime.system) / 1_000 : (windowsCpu?.cpuSystemMs ?? null),
    peakTreeRssBytes: samples ? peak : null,
    rssSamples: samples,
    report,
  }
}

const binaryBefore = sha256(binary)
const launches = [await launch('first', true)]
for (let trial = 1; trial <= trials; trial++) launches.push(await launch(`trial-${trial}`, false))
if (sha256(binary) !== binaryBefore) throw new Error('The baseline binary changed during trials')
const summary = summarizeBaseline(launches)
const record = {
  schemaVersion: 1,
  status: summary.measured === trials && summary.failed.length === 0 ? 'passed' : 'failed',
  startedAt: new Date(launches[0]!.spawnEpochMs).toISOString(),
  command: process.argv,
  binary: { path: binary, bytes: statSync(binary).size, sha256: binaryBefore },
  workload,
  environment: {
    os: platform(),
    release: release(),
    arch: arch(),
    cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    rustc: optional(['rustc', '--version']),
    display: {
      DISPLAY: process.env['DISPLAY'] ?? null,
      WAYLAND_DISPLAY: process.env['WAYLAND_DISPLAY'] ?? null,
    },
    load: windowsApi
      ? windowsLoad(windowsApi)
      : platform() === 'darwin'
        ? optional(['sysctl', '-n', 'vm.loadavg'])
        : readFileSync('/proc/loadavg', 'utf8').trim(),
  },
  methodology: {
    equivalence:
      'same window, element tree shape, default look, warmup, phase counts and lifecycle as benchmarks/solid/workload.ts, written as an ordinary GPUI view with no Bun, protocol or IPC. Each report must show the exact mutation counts and the expected final paint.',
    timings:
      'apply is the state mutation plus notify, the nearest analogue of the Bun Native acknowledgement (which also includes IPC, JavaScript and tree preparation); turn adds one yielded foreground turn; toPaint is a separate, frame-paced phase and is not comparable with acknowledgements',
    startup:
      'controller spawn epoch combined with the child wall-clock origin; viewMounted is state applied, firstPaint is the first GPUI paint of the mounted view',
    cpu: windowsApi
      ? 'final GetProcessTimes user plus kernel time of the baseline process and any descendant observed'
      : 'wait4 user plus system time of the baseline process',
    rss: `sampled ${windowsApi ? 'working set (K32GetProcessMemoryInfo)' : platform() === 'darwin' ? 'ps rss' : '/proc statm'} of the process and its descendants every ${rssInterval} ms; peaks can be missed`,
    failures: 'failed launches are retained and excluded; never retried',
    firstLaunch: 'launch "first" runs once before the trials and is reported separately',
  },
  launches,
  summary,
}
writeFileSync(join(output, 'rust-gpui.json'), JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify({ status: record.status, failed: summary.failed }, null, 2))
if (record.status !== 'passed') process.exit(1)
