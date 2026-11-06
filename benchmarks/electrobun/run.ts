import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'

// Electrobun system-WebView baseline for the matched renderer workload (#244).
// It launches a prebuilt Electrobun .app N times and records process-level metrics
// the Bun Native comparison also records: spawn to view mounted, process wall time,
// peak process-tree RSS and bundle bytes. macOS only. The WebKit XPC helpers are not
// descendants of the app, so their RSS is attributed heuristically (see `webKitHelpers`).
const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    output: { type: 'string' },
    trials: { type: 'string', default: '5' },
    iterations: { type: 'string', default: '1000' },
    rotations: { type: 'string', default: '1000' },
    mounts: { type: 'string', default: '100' },
    rows: { type: 'string', default: '32' },
    'rss-interval-ms': { type: 'string', default: '20' },
  },
  strict: true,
  allowPositionals: false,
})
if (platform() !== 'darwin') throw new Error('The Electrobun baseline runner is macOS only')
if (!values.app || !isAbsolute(values.app) || !values.output || !isAbsolute(values.output))
  throw new Error('--app and --output require absolute paths')
if (existsSync(values.output)) throw new Error('--output must not exist yet')
const trials = Number(values.trials)
assert(Number.isInteger(trials) && trials >= 3 && trials <= 30, 'trials must be 3..30')
const rssInterval = Number(values['rss-interval-ms'])
const launcher = join(values.app, 'Contents/MacOS/launcher')
assert(existsSync(launcher), 'The .app must contain Contents/MacOS/launcher')
mkdirSync(join(values.output, 'launches'), { recursive: true })

function run(argv: string[]) {
  const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}
interface Row {
  pid: number
  parent: number
  rssBytes: number
  command: string
}
function snapshot(): Row[] {
  const listing = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,rss=,comm='], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5_000,
  })
  const rows: Row[] = []
  for (const line of listing.stdout.toString().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match)
      rows.push({
        pid: Number(match[1]),
        parent: Number(match[2]),
        rssBytes: Number(match[3]) * 1024,
        command: match[4]!,
      })
  }
  return rows
}
const isWebKitHelper = (row: Row) =>
  /com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(row.command)

function summarize(samples: number[], seed = 244) {
  const sorted = [...samples].sort((a, b) => a - b)
  const median = (items: number[]) => {
    const copy = [...items].sort((a, b) => a - b)
    const middle = copy.length >> 1
    return copy.length % 2 ? copy[middle]! : (copy[middle - 1]! + copy[middle]!) / 2
  }
  let state = seed
  const random = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const medians = Array.from({ length: 2000 }, () =>
    median(samples.map(() => samples[Math.floor(random() * samples.length)]!))
  ).sort((a, b) => a - b)
  return {
    count: samples.length,
    min: sorted[0]!,
    median: median(samples),
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    max: sorted.at(-1)!,
    medianCi95: [medians[Math.floor(0.025 * 2000)]!, medians[Math.floor(0.975 * 2000)]!],
  }
}

async function launch(name: string) {
  const out = join(values.output!, 'launches', `${name}.json`)
  const before = new Set(
    snapshot()
      .filter(isWebKitHelper)
      .map((row) => row.pid)
  )
  const spawnEpochMs = Date.now()
  const started = performance.now()
  const child = Bun.spawn([launcher], {
    stdout: Bun.file(join(values.output!, 'launches', `${name}.stdout.log`)),
    stderr: Bun.file(join(values.output!, 'launches', `${name}.stderr.log`)),
    env: {
      ...process.env,
      EB_OUTPUT: out,
      EB_ITERATIONS: values.iterations!,
      EB_ROTATIONS: values.rotations!,
      EB_MOUNTS: values.mounts!,
      EB_ROWS: values.rows!,
    },
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  let exited = false
  void child.exited.then(() => (exited = true))
  let peakProcess = 0
  let peakHelpers = 0
  let peakTotal = 0
  let samples = 0
  const helperPids = new Set<number>()
  while (!exited) {
    const rows = snapshot()
    const children = new Set([child.pid])
    for (let grew = true; grew;) {
      grew = false
      for (const row of rows)
        if (!children.has(row.pid) && children.has(row.parent)) {
          children.add(row.pid)
          grew = true
        }
    }
    const processBytes = rows
      .filter((row) => children.has(row.pid))
      .reduce((s, r) => s + r.rssBytes, 0)
    const helpers = rows.filter((row) => isWebKitHelper(row) && !before.has(row.pid))
    for (const row of helpers) helperPids.add(row.pid)
    const helperBytes = helpers.reduce((s, r) => s + r.rssBytes, 0)
    if (processBytes > 0) {
      samples++
      peakProcess = Math.max(peakProcess, processBytes)
      peakHelpers = Math.max(peakHelpers, helperBytes)
      peakTotal = Math.max(peakTotal, processBytes + helperBytes)
    }
    await Promise.race([Bun.sleep(rssInterval), child.exited])
  }
  const exitCode = await child.exited
  clearTimeout(timer)
  const wallMs = performance.now() - started
  const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
  const failed = exitCode !== 0 || !report || report.error
  return {
    name,
    status: failed ? 'failed' : 'passed',
    exitCode,
    wallMs,
    spawnEpochMs,
    peakProcessTreeRssBytes: peakProcess,
    peakNewWebKitHelperRssBytes: peakHelpers,
    peakTotalRssBytes: peakTotal,
    newWebKitHelperProcesses: helperPids.size,
    rssSamples: samples,
    spawnToMainEntryMs: report
      ? report.mainProcessStartEpochMs + report.mainEntryMs - spawnEpochMs
      : null,
    spawnToWindowCreatedMs: report
      ? report.mainProcessStartEpochMs + report.windowCreatedMs - spawnEpochMs
      : null,
    spawnToViewMountedMs: report
      ? report.startup.timeOriginEpochMs + report.startup.viewMountedMs - spawnEpochMs
      : null,
    report,
  }
}

function bundleBytes(path: string) {
  const listing = run(['du', '-sk', path])
  return listing ? Number(listing.split(/\s+/)[0]) * 1024 : null
}
function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const launches = [await launch('first')]
for (let trial = 1; trial <= trials; trial++) launches.push(await launch(`trial-${trial}`))
const measured = launches.slice(1).filter((item) => item.status === 'passed')
const metric = (pick: (item: (typeof launches)[number]) => number | null) =>
  summarize(measured.map(pick).filter((value): value is number => value !== null))
const phaseMedians = (phase: string, key: 'synchronousSubmission' | 'toNextFrame') =>
  summarize(measured.map((item) => item.report.phases[phase][key].p50Ms))
const summary = {
  spawnToViewMountedMs: metric((item) => item.spawnToViewMountedMs),
  processWallMs: metric((item) => item.wallMs),
  peakProcessTreeRssMB: summarize(measured.map((item) => item.peakProcessTreeRssBytes / 1e6)),
  peakNewWebKitHelperRssMB: summarize(
    measured.map((item) => item.peakNewWebKitHelperRssBytes / 1e6)
  ),
  peakTotalRssMB: summarize(measured.map((item) => item.peakTotalRssBytes / 1e6)),
  signalsSubmissionP50Ms: phaseMedians('signals', 'synchronousSubmission'),
  signalsToNextFrameP50Ms: phaseMedians('signals', 'toNextFrame'),
  rotationSubmissionP50Ms: phaseMedians('keyedRotations', 'synchronousSubmission'),
  rotationToNextFrameP50Ms: phaseMedians('keyedRotations', 'toNextFrame'),
  lifecycleP50Ms: summarize(measured.map((item) => item.report.lifecycles.p50Ms)),
}
const record = {
  schemaVersion: 1,
  status: measured.length === trials ? 'passed' : 'failed',
  startedAt: new Date().toISOString(),
  command: process.argv,
  app: {
    path: values.app,
    bundleBytes: bundleBytes(values.app),
    launcherSha256: sha256(launcher),
    bunSha256: sha256(join(values.app, 'Contents/MacOS/bun')),
    infoPlist: run(['plutil', '-p', join(values.app, 'Contents/Info.plist')]),
  },
  toolchain: {
    hutchConfig: readFileSync(join(import.meta.dir, 'app/hutch.config.ts'), 'utf8'),
  },
  target: {
    os: platform(),
    osRelease: `macOS ${run(['sw_vers', '-productVersion'])} (${run(['sw_vers', '-buildVersion'])})`,
    architecture: arch(),
    kernel: release(),
    cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    load: run(['sysctl', '-n', 'vm.loadavg']),
    power: run(['pmset', '-g', 'batt']),
    webKit: run([
      'defaults',
      'read',
      '/System/Library/Frameworks/WebKit.framework/Resources/Info',
      'CFBundleVersion',
    ]),
  },
  workload: {
    iterations: Number(values.iterations),
    rotations: Number(values.rotations),
    mounts: Number(values.mounts),
    rows: Number(values.rows),
  },
  methodology: {
    equivalence:
      'same tree shape (label, button, keyed rows), phase counts and lifecycle as benchmarks/solid/workload.ts, in a DOM. Operation timings are DOM mutation time and time to the next animation frame; neither equals the Bun Native host acknowledgement, so do not compare them across harnesses.',
    startup:
      'controller spawn epoch to the page performance.timeOrigin + viewMounted (first animation frame after mount); not display presentation',
    rss: `ps rss of the launcher and its descendants every ${rssInterval} ms, plus WebKit helper processes (com.apple.WebKit.WebContent/GPU/Networking) that did not exist before the launch. Those helpers are launchd XPC services, so any other application starting WebKit work during the run is also counted: this is a heuristic upper bound.`,
    failures: 'failed launches are retained and excluded; never retried',
    firstLaunch: 'launch "first" is reported separately and excluded from the summary',
  },
  launches,
  summary,
}
writeFileSync(join(values.output, 'electrobun.json'), JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify({ status: record.status, summary }, null, 2))
if (record.status !== 'passed') process.exit(1)
