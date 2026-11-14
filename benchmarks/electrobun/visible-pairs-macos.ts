/** Hosted qualification and descriptive pairs; capture completion is not presentation. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { describe, bootstrapMedian } from '../comparison/stats.ts'
import { visiblePairsPlan, type Trial, type Variant } from './visible-pairs-plan.ts'

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    'native-app': { type: 'string' },
    'native-host': { type: 'string' },
    output: { type: 'string' },
    helper: { type: 'string' },
    ocr: { type: 'string' },
    pairs: { type: 'string', default: '10' },
  },
  strict: true,
})
assert(
  process.platform === 'darwin' && process.env['GITHUB_ACTIONS'] === 'true',
  'Hosted macOS only'
)
const temp = realpathSync(process.env['RUNNER_TEMP'] ?? '')
function owned(value: string | undefined, exists: boolean) {
  assert(value && isAbsolute(value), 'Absolute path required')
  const path = exists
    ? realpathSync(value)
    : join(realpathSync(dirname(value)), value.split('/').at(-1)!)
  const part = relative(temp, path)
  assert(part && !part.startsWith('..') && !isAbsolute(part), 'Path must be inside RUNNER_TEMP')
  return path
}
const app = owned(values.app, true)
const nativeApp = owned(values['native-app'], true)
const nativeHost = owned(values['native-host'], true)
const helper = owned(values.helper, true)
const ocr = owned(values.ocr, true)
const output = owned(values.output, false)
assert(!existsSync(output), 'Output already exists')
const plan = visiblePairsPlan(Number(values.pairs))
mkdirSync(output)
writeFileSync(join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
type Observation = {
  trial: Trial
  directory: string
  exitCode: number
  result: Record<string, unknown> | undefined
}
const observations: Observation[] = []
const fingerprints = new Map<Variant, string>()
let viewport: string | undefined
let failure: string | undefined
try {
  for (const [index, trial] of plan.entries()) {
    const directory = `${String(index + 1).padStart(3, '0')}-${trial.phase}-${trial.variant}`
    const path = join(output, directory)
    const args =
      trial.variant === 'reference'
        ? ['--app', app]
        : ['--native-app', nativeApp, '--native-host', nativeHost]
    const child = Bun.spawn(
      [
        process.execPath,
        'benchmarks/electrobun/visible-smoke-macos.ts',
        ...args,
        '--output',
        path,
        '--helper',
        helper,
        '--ocr',
        ocr,
      ],
      {
        stdout: Bun.file(join(output, `${directory}.stdout.log`)),
        stderr: Bun.file(join(output, `${directory}.stderr.log`)),
      }
    )
    const exitCode = await child.exited
    const resultPath = join(path, 'result.json')
    const result = existsSync(resultPath)
      ? (JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>)
      : undefined
    observations.push({ trial, directory, exitCode, result })
    writeFileSync(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n')
    assert.equal(exitCode, 0, `${directory} failed; evidence retained`)
    assert.equal(result?.['status'], 'passed')
    const fingerprint = JSON.stringify(result['artifacts'])
    const previous = fingerprints.get(trial.variant)
    if (previous) assert.equal(fingerprint, previous, `${trial.variant} binaries changed`)
    else fingerprints.set(trial.variant, fingerprint)
    const currentViewport = JSON.stringify(result['viewport'])
    if (viewport) assert.equal(currentViewport, viewport, 'Viewport changed')
    else viewport = currentViewport
    const elapsed = result['commandToDisplayCaptureObservedMs']
    assert(typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed > 0)
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
}
const summaries: Record<string, unknown> = {}
if (!failure) {
  const elapsed = (item: Observation) => Number(item.result!['commandToDisplayCaptureObservedMs'])
  for (const variant of ['reference', 'native'] as const) {
    const controls = observations.filter(
      (item) => item.trial.phase === 'control' && item.trial.variant === variant
    )
    const differences = [0, 1, 2].map((pair) => {
      const items = controls.filter((item) => item.trial.pair === pair)
      return elapsed(items[1]!) - elapsed(items[0]!)
    })
    summaries[`${variant}ControlDifferencesMs`] = {
      raw: differences,
      distribution: describe(differences),
    }
  }
  const differences = Array.from({ length: Number(values.pairs) }, (_, pair) => {
    const items = observations.filter(
      (item) => item.trial.phase === 'comparison' && item.trial.pair === pair
    )
    return (
      elapsed(items.find((item) => item.trial.variant === 'native')!) -
      elapsed(items.find((item) => item.trial.variant === 'reference')!)
    )
  })
  summaries['nativeMinusReferenceMs'] = {
    raw: differences,
    distribution: describe(differences),
    interval: bootstrapMedian(differences),
  }
}
writeFileSync(
  join(output, 'summary.json'),
  JSON.stringify(
    {
      status: failure ? 'failed' : 'passed',
      failure,
      planned: plan.length,
      completed: observations.length,
      viewport,
      summaries,
      scope:
        'Hosted VM; command to verified display-capture observation includes observer overhead, not physical presentation. A/A controls are descriptive, not a precision guarantee. No product ranking follows from this fixture.',
    },
    null,
    2
  ) + '\n'
)
if (failure) throw new Error(failure)
