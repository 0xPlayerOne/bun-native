import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { portableWorkloads } from '../benchmarks/foundation/portable.ts'
import { distribution, profileOptions } from '../benchmarks/foundation/statistics.ts'
import { schedule } from '../benchmarks/lib/statistics.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'

const root = resolve(import.meta.dir, '..')
const options = profileOptions(
  process.argv.slice(2),
  join(root, '.bunly/profiles', 'foundation-' + randomUUID() + '.json')
)
const output = resolve(options.output)
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
if (
  await lstat(output).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
)
  throw new Error('Profile output already exists; use a new path')
const paths = [
  'scripts/profile-foundation.ts',
  'benchmarks/foundation/portable.ts',
  'benchmarks/foundation/statistics.ts',
  'benchmarks/lib/statistics.ts',
  'packages/runtime/src/native-transport.ts',
  'packages/contracts/src/rpc-wire.ts',
  'packages/artifacts/src/cef-cache.ts',
  'packages/artifacts/src/cef-manifest.ts',
  'packages/artifacts/src/kernel-lock.ts',
]
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ])
    )
  )
const hashesBefore = await fingerprints()
const fixture = await portableWorkloads(join(root, '.bunly/profiles'))
const sourceBefore = sourceIdentity(root)
const observations = new Map(fixture.workloads.map((workload) => [workload.name, [] as number[]]))
const results: Record<string, unknown> = {
  schema: 1,
  classification: 'descriptive-foundation-profile',
  passed: false,
  nativeBrowserExecuted: false,
  sourceBefore,
  sourceHashes: hashesBefore,
  environment: {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? 'unknown',
  },
  samples: options.samples,
  warmups: options.warmups,
  method:
    'Seeded shuffled workload order per repetition; elapsed time includes correctness checks. Raw samples and percentile-bootstrap mean interval, no timing threshold.',
  limitations: [
    'Protocol peers and synthetic signed cache, not native rendering or desktop startup.',
    'No quiet-machine or thermal gate; bootstrap intervals describe this run, not between-machine uncertainty.',
    'Use profile:foundation:native for prepared CEF startup, concurrent assets and renderer responsiveness.',
    'CPU profiling adds overhead; compare only runs with the same profiling options.',
  ],
}
try {
  const cases = new Map(fixture.workloads.map((workload) => [workload.name, workload]))
  for (let warmup = 0; warmup < options.warmups; warmup++)
    for (const item of fixture.workloads) await item.run()
  for (const item of schedule([...cases.keys()], options.samples, 0x42554e)) {
    const started = performance.now()
    await cases.get(item.variant)!.run()
    observations.get(item.variant)!.push(performance.now() - started)
  }
  results['workloads'] = fixture.workloads.map((workload) => ({
    name: workload.name,
    parameters: workload.parameters,
    elapsedMs: distribution(observations.get(workload.name)!),
  }))
  results['passed'] = true
} catch (error) {
  results['failure'] = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await fixture.close()
  results['rawSamplesMs'] = Object.fromEntries(observations)
  results['sourceHashesAfter'] = await fingerprints()
  if (JSON.stringify(results['sourceHashesAfter']) !== JSON.stringify(hashesBefore)) {
    results['passed'] = false
    results['failure'] = 'Profile source changed during measurement'
    process.exitCode = 1
  }
  results['sourceAfter'] = sourceIdentity(root)
  await writeFile(output, JSON.stringify(results, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ passed: results['passed'], output, failure: results['failure'] }))
}
