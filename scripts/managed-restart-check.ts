/** One separately observed full relaunch of the already verified prepared host. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { RESTART_DEADLINE_MS } from '../examples/managed-desktop/restart-contract.ts'
import { observedCommand } from '../benchmarks/lib/observed-command.ts'
import { managedObservationContentSha256 } from '../benchmarks/reload/managed-observation.ts'
import {
  MANAGED_RESTART_CONFIGURATION,
  MANAGED_RESTART_OBSERVER_MS,
  MANAGED_RESTART_PROFILE,
  acceptManagedRestartReport,
  acceptManagedRestartWorkload,
} from '../benchmarks/reload/managed-restart-acceptance.ts'

const hash = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')
async function bounded(path: string, maximum: number): Promise<Buffer> {
  const stat = await lstat(path)
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum,
    'Invalid bounded restart evidence file'
  )
  const bytes = await readFile(path)
  assert.equal(bytes.length, stat.size)
  return bytes
}
export async function runManagedRestartCheck(options: {
  readonly executable: string
  readonly cwd: string
  readonly project: string
  readonly serviceRunner: string
  readonly previousIdentities: Readonly<Record<string, string>>
  readonly previousRendererInstance: string
}): Promise<Record<string, unknown>> {
  for (const path of [options.executable, options.cwd, options.project, options.serviceRunner])
    assert.ok(isAbsolute(path), 'Controlled restart requires explicit owned absolute paths')
  const output = join(options.cwd, 'restart')
  // No retry and no reuse of a prior launch's evidence directory.
  await mkdir(output, { mode: 0o700 })
  const report: Record<string, unknown> = {
    schema: 1,
    profile: MANAGED_RESTART_PROFILE,
    passed: false,
    attempted: false,
    launches: 0,
    observerTimeoutMs: MANAGED_RESTART_OBSERVER_MS,
    fixtureDeadlineMs: RESTART_DEADLINE_MS,
    performanceEligible: false,
  }
  try {
    const configPath = join(options.project, 'bunly-dev.json')
    const configuration = await bounded(configPath, 4096)
    assert.equal(configuration.toString(), MANAGED_RESTART_CONFIGURATION)
    const configurationSha256 = hash(configuration)
    report['configurationSha256'] = configurationSha256
    const resultPath = join(output, 'result.json'),
      observationPath = join(output, 'process.json')
    report['attempted'] = true
    report['launches'] = 1
    const observation = await observedCommand([options.executable], {
      cwd: options.cwd,
      output: observationPath,
      timeoutMs: MANAGED_RESTART_OBSERVER_MS,
      env: {
        BUNLY_MANAGED_MODE: 'restart-check',
        BUNLY_MANAGED_ROOT: options.project,
        BUNLY_SERVICE_RUNNER: options.serviceRunner,
        BUNLY_MANAGED_RESTART_RESULT: resultPath,
        BUNLY_CACHE_DIR: join(output, 'browser-profile'),
        BUNLY_BENCH_SANDBOX: '1',
        PATH: '',
      },
    }).result
    report['observation'] = observation
    report['observationSha256'] = hash(await bounded(observationPath, 64 * 1024 * 1024))
    report['observationContentSha256'] = managedObservationContentSha256(observation)
    const result = await bounded(resultPath, 256 * 1024)
    report['resultText'] = result.toString()
    report['resultBytes'] = result.length
    report['resultSha256'] = hash(result)
    assert.deepEqual(
      await bounded(configPath, 4096),
      configuration,
      'Restart rewrote the selected configuration'
    )
    report['configurationUnchanged'] = true
    report['launchPathEmpty'] = true
    const context = {
      previousIdentities: options.previousIdentities,
      previousRendererInstance: options.previousRendererInstance,
      configurationSha256,
    }
    report['acceptance'] = acceptManagedRestartWorkload(observation, result.toString(), context)
    report['passed'] = true
    acceptManagedRestartReport(report, context)
  } catch (error) {
    report['passed'] = false
    report['failure'] = error instanceof Error ? error.message : 'Controlled restart failed'
  } finally {
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
  }
  return report
}
