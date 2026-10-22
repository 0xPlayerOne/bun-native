import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixtureServer } from '../../fixtures/server.ts'
import { fixtureBytes, checksum } from '../../fixtures/data.ts'
import { loadWorkbenchAssets } from '../../../scripts/workbench.ts'
import { electrobunLayout } from './layout.ts'
import type { Trial, Variant } from '../../lib/results.ts'
export const electrobunIdentity: Variant = {
  id: 'electrobun',
  framework: 'Electrobun',
  version: '2.0.3-beta.26',
  sourceCommit: 'c4bbeca07829d9b1634d31598ef6091fb19ace2a',
  runtime: 'Bun',
  runtimeVersion: 'unverified',
  engine: 'chromium',
  engineVersion: null,
  securityProfile: 'rpc-disabled+cef-process-sandbox-unverified',
  configuration: 'tuned',
}
export async function electrobunScenario(
  scenario: string
): Promise<Pick<Trial, 'status' | 'reason' | 'correctness' | 'metrics'>> {
  if (!['app-launch', 'terminal-render'].includes(scenario))
    return {
      status: 'unsupported',
      reason: 'This initial Electrobun adapter implements launch and terminal rendering only',
      correctness: { passed: false, details: 'Not executed, no timing assigned' },
      metrics: {},
    }
  const layout = await electrobunLayout()
  const token = randomBytes(24).toString('hex')
  const server = await createFixtureServer(await loadWorkbenchAssets(), {
    completion: { token, scenario },
  })
  const directory = join(layout.root, '.bunly/benchmarks')
  await mkdir(directory, { recursive: true })
  const id = crypto.randomUUID()
  const observationPath = join(directory, `electrobun-observation-${id}.json`)
  const reportPath = join(directory, `electrobun-runtime-${id}.json`)
  try {
    const observer = Bun.spawn(
      [
        process.env['PYTHON'] ?? 'python',
        join(layout.root, 'scripts/observe-process.py'),
        '--output',
        observationPath,
        '--timeout',
        '30',
        '--',
        layout.executable,
      ],
      {
        cwd: join(layout.application, 'Contents/MacOS'),
        stdout: 'inherit',
        stderr: 'inherit',
        env: {
          ...process.env,
          BUNLY_FIXTURE_ORIGIN: server.origin,
          BUNLY_REPORT_TOKEN: token,
          BUNLY_SCENARIO: scenario,
          BUNLY_REPORT_PATH: reportPath,
        },
      }
    )
    const exitCode = await observer.exited
    const observation = JSON.parse(await readFile(observationPath, 'utf8')) as {
      exitCode: number
      timedOut: boolean
      observedOrphans: number[]
      stderr: string[]
      peakTreeRssBytes: number
      peakTreeThreads: number
    }
    if (
      exitCode !== 0 ||
      observation.exitCode !== 0 ||
      observation.timedOut ||
      observation.observedOrphans.length
    )
      throw new Error(JSON.stringify({ observationPath, observation }))
    if (!(await Bun.file(reportPath).exists()))
      throw new Error(
        JSON.stringify({
          error: 'Missing runtime report',
          observationPath,
          stderr: observation.stderr,
        })
      )
    const report = (await Bun.file(reportPath).json()) as Record<string, unknown>
    if (report['passed'] !== true) throw new Error(JSON.stringify({ report, observationPath }))
    assert.equal(report['scenario'], scenario)
    const fixture = report['fixture'] as Record<string, unknown>
    assert.equal(fixture['nativeGlobalsAbsent'], true)
    assert.equal(fixture['passed'], true)
    if (scenario === 'terminal-render') {
      const expected = fixtureBytes()
      assert.equal(fixture['bytes'], expected.length)
      assert.equal(fixture['checksum'], checksum(expected))
    }
    if (
      typeof report['runtimeVersion'] !== 'string' ||
      typeof report['userAgentVersion'] !== 'string'
    )
      throw new Error('Missing actual runtime/user-agent observation')
    assert.equal(
      report['engineVersion'],
      null,
      'Reduced user agent must not masquerade as an exact engine identity'
    )
    if (
      electrobunIdentity.runtimeVersion !== 'unverified' &&
      electrobunIdentity.runtimeVersion !== report['runtimeVersion']
    )
      throw new Error('Packaged Bun changed within the run')
    electrobunIdentity.runtimeVersion = report['runtimeVersion']
    const metrics: Trial['metrics'] = {
      mainEntryToReport: { value: Number(report['mainEntryToReportMs']), unit: 'ms' },
      peakTreeRss: { value: observation.peakTreeRssBytes, unit: 'bytes' },
      peakTreeThreads: { value: observation.peakTreeThreads, unit: 'count' },
    }
    if (scenario === 'terminal-render')
      metrics['terminalConsumedThenTwoFrames'] = {
        value: Number(fixture['terminalConsumedThenTwoFramesMs']),
        unit: 'ms',
      }
    return {
      status: 'passed',
      reason:
        'Actual packaged Electrobun/Bun/CEF launch; exact CEF identity and process sandbox remain unverified',
      correctness: {
        passed: true,
        details:
          'Observed native launcher exit and renderer completion; terminal bytes/checksum validated where applicable',
      },
      metrics,
    }
  } finally {
    await server.close()
  }
}
