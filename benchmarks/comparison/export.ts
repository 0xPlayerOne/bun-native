import { gzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

// Copy a finished comparison into a compact, committable record and print a
// Markdown summary table. Raw child reports are kept verbatim as gzipped JSONL.
const [input, destination] = process.argv.slice(2)
if (!input || !destination || !isAbsolute(input) || !isAbsolute(destination))
  throw new Error('Usage: bun benchmarks/comparison/export.ts ABSOLUTE_RUN_OUTPUT ABSOLUTE_DEST')
if (existsSync(destination)) throw new Error('Destination must not exist')
const comparison = JSON.parse(readFileSync(join(input, 'comparison.json'), 'utf8'))
mkdirSync(destination, { recursive: true })
writeFileSync(join(destination, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n')
const lines: string[] = []
for (const launch of comparison.launches as { name: string }[]) {
  const path = join(input, 'launches', `${launch.name}.json`)
  const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  const stderr = join(input, 'launches', `${launch.name}.stderr.log`)
  lines.push(
    JSON.stringify({
      name: launch.name,
      report,
      stderrTail: existsSync(stderr) ? readFileSync(stderr, 'utf8').slice(-4000) : null,
    })
  )
}
writeFileSync(join(destination, 'launches.jsonl.gz'), gzipSync(lines.join('\n') + '\n'))

type Stat = {
  median: number | null
  p95: number | null
  medianInterval: { low: number | null; high: number | null }
}
const groups = comparison.summary?.groups ?? {}
const metrics: [string, string, number][] = [
  ['spawnToViewMountedMs', 'spawn to view mounted (ms)', 1],
  ['processWallMs', 'process wall (ms)', 1],
  ['peakTreeRssBytes', 'peak tree RSS (MB)', 1e-6],
  ['peakApplicationRssBytes', 'peak app RSS (MB)', 1e-6],
  ['peakHostRssBytes', 'peak host RSS (MB)', 1e-6],
  ['signalsAcknowledgementMedianMs', 'update ack median (ms)', 1],
  ['keyedRotationsAcknowledgementMedianMs', 'rotation ack median (ms)', 1],
  ['lifecycleMedianMs', 'mount/update/dispose median (ms)', 1],
]
const format = (value: number | null, scale: number) =>
  value === null ? 'n/a' : (value * scale).toFixed(scale === 1 ? 2 : 1)
const keys = Object.keys(groups)
console.log(`| Metric (median [95% CI]) | ${keys.join(' | ')} |`)
console.log(`| --- | ${keys.map(() => '---').join(' | ')} |`)
for (const [metric, label, scale] of metrics) {
  const cells = keys.map((key) => {
    const stat: Stat | undefined = groups[key].perLaunch[metric]
    if (!stat) return 'n/a'
    return `${format(stat.median, scale)} [${format(stat.medianInterval.low, scale)}, ${format(stat.medianInterval.high, scale)}]`
  })
  console.log(`| ${label} | ${cells.join(' | ')} |`)
}
console.log(
  `| measured / failed launches | ${keys.map((key) => `${groups[key].measured} / ${groups[key].failed.length}`).join(' | ')} |`
)
console.log()
console.log('| Pooled operation samples (ms) | ' + keys.join(' | ') + ' |')
console.log(`| --- | ${keys.map(() => '---').join(' | ')} |`)
for (const phase of ['signals', 'coalesced', 'keyedRotations', 'lifecycles']) {
  const cells = keys.map((key) => {
    const stat = groups[key].pooledOperationSamplesMs[phase]
    return `${format(stat.median, 1)} / ${format(stat.p95, 1)} / ${format(stat.p99, 1)}`
  })
  console.log(`| ${phase} p50 / p95 / p99 | ${cells.join(' | ')} |`)
}
console.log()
console.log('| Build | module fresh / rebuild (ms) | AOT compile (ms) | module bytes | AOT bytes |')
console.log('| --- | --- | --- | --- | --- |')
for (const [adapter, build] of Object.entries(comparison.builds as Record<string, any>))
  console.log(
    `| ${adapter} | ${build.moduleBuildWallMs.fresh.toFixed(0)} / ${build.moduleBuildWallMs.unchangedRebuild.toFixed(0)} | ${build.aotCompileWallMs.toFixed(0)} | ${build.development.bytes} | ${build.aot.bytes} |`
  )
