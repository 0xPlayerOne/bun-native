import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  runDesktopEdits,
  assertExpectedCompileFailure,
  desktopExitFailure,
  type DesktopEditAdapter,
} from '../benchmarks/lib/desktop-edits.ts'
import { type CommandObservation } from '../benchmarks/lib/observed-command.ts'
const clean = (changes: Partial<CommandObservation> = {}): CommandObservation => ({
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  cleanupSurvivors: [],
  outputOverflow: false,
  observedOrphans: [],
  elapsedMs: 1,
  peakTreeRssBytes: 0,
  peakTreeThreads: 0,
  stdoutTail: [],
  stderr: [],
  samples: [],
  environment: { classification: 'synthetic-unit-observation-not-measurement' },
  ...changes,
})
const compilerFailure = clean({ exitCode: 1, stderr: ['revision.ts:1: Unexpected ;'] })
interface Faults {
  stale?: boolean
  unchangedDocument?: boolean
  badBuildAccepted?: boolean
  brokenDiagnostic?: boolean
  orphan?: boolean
  earlyExit?: boolean
  stateLost?: boolean
}
/** Synthetic reports are confined to unit tests; kind never becomes desktop. */
function harness(faults: Faults = {}) {
  const events: string[] = [],
    tasks: Promise<unknown>[] = []
  let revision = 'initial',
    built = 'initial',
    generations = 0
  const adapter: DesktopEditAdapter = {
    kind: 'harness-test',
    artifactKind: 'main-bundle',
    framework: 'unit-fixture',
    version: '1',
    html: '<!doctype html>',
    javascript: 'void 0;',
    state: { token: 'disk-state', counter: 1 },
    async writeRevision(value) {
      events.push('write:' + value)
      revision = value
    },
    async verifyState() {
      if (faults.stateLost && generations > 1) throw new Error('State lost')
    },
    async build() {
      events.push('build:' + revision)
      if (revision === 'broken')
        return faults.badBuildAccepted
          ? clean()
          : faults.brokenDiagnostic
            ? clean({ exitCode: 1, stderr: ['network unavailable'] })
            : compilerFailure
      if (!faults.stale || generations === 0) built = revision
      return clean()
    },
    async launch(config) {
      events.push('launch:' + built)
      generations++
      if (faults.earlyExit) return { path: 'unit-only', result: Promise.resolve(clean()) }
      let resolveExit!: (value: CommandObservation) => void
      const result = new Promise<CommandObservation>((resolve) => {
        resolveExit = resolve
      })
      const work = (async () => {
        const nativeHeaders = {
          'content-type': 'application/json',
          'x-bunly-probe-token': config.hostToken,
        }
        const response = await fetch(config.origin + '/host', {
          method: 'POST',
          headers: nativeHeaders,
          body: JSON.stringify({
            launch: config.launch,
            revision: built,
            instance: randomUUID(),
            state: 'disk-state',
            counter: 1,
            pid: process.pid,
            framework: 'unit-fixture',
            frameworkVersion: '1',
            runtimeVersion: Bun.version,
            engineVersion: null,
            sandbox: 'unverified',
          }),
        })
        if (response.status !== 202) {
          resolveExit(clean({ exitCode: 1 }))
          return
        }
        await fetch(config.origin + '/renderer', {
          method: 'POST',
          headers: {
            ...nativeHeaders,
            'x-bunly-probe-token': config.rendererToken,
            origin: config.origin,
          },
          body: JSON.stringify({
            launch: config.launch,
            revision: built,
            document: faults.unchangedDocument ? 'same-document' : randomUUID(),
            state: 'disk-state',
            counter: 1,
            nativeGlobalsAbsent: true,
            frameOpportunities: 2,
          }),
        })
        const command = await fetch(config.origin + '/command', { headers: nativeHeaders })
        if (!command.ok) {
          resolveExit(clean({ exitCode: 1 }))
          return
        }
        const value = (await command.json()) as { command: string }
        if (value.command !== 'quit') throw new Error('Test command did not shut down')
        events.push('reaped:' + built)
        resolveExit(clean({ observedOrphans: faults.orphan ? [999] : [] }))
      })().catch(() => resolveExit(clean({ exitCode: 1 })))
      tasks.push(work)
      return { path: 'synthetic-unit-only', result }
    },
  }
  return { adapter, events, tasks }
}
test('desktop edit transaction runs all five steps and reaps before the next build', async () => {
  const fixture = harness(),
    result = await runDesktopEdits(fixture.adapter, { readinessTimeoutMs: 1000 })
  await Promise.all(fixture.tasks)
  expect(result.passed).toBe(true)
  expect(result.kind).toBe('harness-test')
  expect(result.steps).toHaveLength(5)
  expect(result.steps.every((step) => step.status === 'passed')).toBe(true)
  expect(fixture.events).toEqual([
    'write:initial',
    'build:initial',
    'launch:initial',
    'write:edited',
    'reaped:initial',
    'build:edited',
    'launch:edited',
    'write:broken',
    'reaped:edited',
    'build:broken',
    'write:repaired',
    'build:repaired',
    'launch:repaired',
    'reaped:repaired',
  ])
})
test('stale successful build cannot pass the backend edit', async () => {
  const fixture = harness({ stale: true }),
    result = await runDesktopEdits(fixture.adapter, { readinessTimeoutMs: 200 })
  expect(result.passed).toBe(false)
  expect(result.steps[2]?.status).toBe('failed')
  expect(result.steps[4]?.status).toBe('not-executed')
})
test('backend relaunch must replace its document, not echo an old acknowledgement', async () => {
  const fixture = harness({ unchangedDocument: true }),
    result = await runDesktopEdits(fixture.adapter, { readinessTimeoutMs: 1000 })
  expect(result.passed).toBe(false)
  expect(result.steps[2]?.reason).toContain('replacement')
})
test('a broken source that reports a successful build is a failure', async () => {
  const fixture = harness({ badBuildAccepted: true }),
    result = await runDesktopEdits(fixture.adapter, { readinessTimeoutMs: 1000 })
  expect(result.passed).toBe(false)
  expect(result.steps[3]?.status).toBe('failed')
  expect(result.steps[4]?.elapsedMs).toBeNull()
})
test('unrelated setup errors are not accepted as deliberate syntax failure', async () => {
  const fixture = harness({ brokenDiagnostic: true }),
    result = await runDesktopEdits(fixture.adapter, { readinessTimeoutMs: 1000 })
  expect(result.steps[3]?.reason).toContain('diagnostic')
  expect(result.passed).toBe(false)
})
test('surviving children stop the experiment instead of contaminating the next trial', async () => {
  const fixture = harness({ orphan: true }),
    result = await runDesktopEdits(fixture.adapter, { readinessTimeoutMs: 1000 })
  expect(result.passed).toBe(false)
  expect(fixture.events).not.toContain('build:edited')
})
test('a desktop process exiting before readiness cannot pass launch', async () => {
  const fixture = harness({ earlyExit: true }),
    result = await runDesktopEdits(fixture.adapter, { readinessTimeoutMs: 1000 })
  expect(result.steps[1]?.status).toBe('failed')
  expect(result.steps[1]?.reason).toContain('before readiness')
  expect(result.steps[2]?.status).toBe('not-executed')
})
test('retained disk state is validated even after correct renderer completion', async () => {
  const fixture = harness({ stateLost: true }),
    result = await runDesktopEdits(fixture.adapter, { readinessTimeoutMs: 1000 })
  expect(result.passed).toBe(false)
  expect(result.steps[2]?.reason).toBe('State lost')
})
test('compiler failure validation rejects timeouts, signals, overflows and surviving descendants', () => {
  expect(() => assertExpectedCompileFailure(compilerFailure)).not.toThrow()
  for (const change of [
    { timedOut: true },
    { cancelled: true },
    { cleanupSurvivors: [1] },
    { outputOverflow: true },
    { observedOrphans: [1] },
    { exitCode: -9 },
    { exitCode: 0 },
    { stderr: ['missing revision.ts'] },
  ]) {
    expect(() => assertExpectedCompileFailure({ ...compilerFailure, ...change })).toThrow()
  }
})
test('both pinned desktop template entrypoints bundle; malformed imported source actually fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-desktop-template-'))
  try {
    const templates = join(import.meta.dir, '../benchmarks/fixtures/desktop-edit')
    for (const name of ['host.ts', 'electron.ts', 'electrobun.ts'])
      await writeFile(join(directory, name), await readFile(join(templates, name + '.txt')))
    await writeFile(join(directory, 'revision.ts'), "export const revision = 'edited';\n")
    for (const name of ['electron', 'electrobun'] as const) {
      const result = await Bun.build({
        entrypoints: [join(directory, name + '.ts')],
        target: name === 'electron' ? 'node' : 'bun',
        format: name === 'electron' ? 'cjs' : 'esm',
        external: ['electron', 'electrobun/main'],
      })
      expect(result.success, result.logs.map(String).join('\n')).toBe(true)
      expect(await result.outputs[0]!.text()).toContain('edited')
    }
    await writeFile(join(directory, 'revision.ts'), 'export const revision = ;\n')
    const failed = Bun.spawnSync([
      process.execPath,
      'build',
      join(directory, 'electron.ts'),
      '--target=node',
      '--format=cjs',
      '--external',
      'electron',
      '--outfile',
      join(directory, 'main.cjs'),
    ])
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stderr.toString()).toContain('revision.ts')
    expect(() =>
      assertExpectedCompileFailure(
        clean({ exitCode: failed.exitCode, stderr: failed.stderr.toString().split('\n') })
      )
    ).not.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('early exit retains recognized administrator failure without logging private page details', () => {
  const message = JSON.stringify({ event: 'fixture-failure', code: 'ERR_BLOCKED_BY_ADMINISTRATOR' })
  expect(desktopExitFailure(clean({ stderr: [message] })).message).toContain(
    'ERR_BLOCKED_BY_ADMINISTRATOR'
  )
  const unknown = JSON.stringify({ event: 'fixture-failure', code: 'private-token-value' })
  expect(desktopExitFailure(clean({ stderr: [unknown] })).message).not.toContain(
    'private-token-value'
  )
  expect(desktopExitFailure(clean({ stderr: ['private page URL'] })).message).toBe(
    'Desktop exited before readiness'
  )
})

// Pinned Electrobun wraps BuildMessage and omits the original source location.
// Attribute the parser error using the fresh token actually written into source.
test('locationless upstream diagnostics require the exact source-fault token', () => {
  const marker = 'BUNLY_INVALID_REVISION_' + 'a'.repeat(24)
  const report = clean({
    exitCode: 1,
    stderr: [
      'BuildMessage: Expected ";" but found "' + marker + '"',
      'error: CottontailBuildFailed',
    ],
  })
  expect(() => assertExpectedCompileFailure(report, marker)).not.toThrow()
  expect(() => assertExpectedCompileFailure(report)).toThrow()
  expect(() => assertExpectedCompileFailure(report, marker.replaceAll('a', 'b'))).toThrow()
  expect(() =>
    assertExpectedCompileFailure(
      clean({ exitCode: 1, stderr: [marker, 'network unavailable'] }),
      marker
    )
  ).toThrow()
  expect(() => assertExpectedCompileFailure({ ...report, timedOut: true }, marker)).toThrow()
})
