import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ownedChild, type OwnedChild } from '../../lib/owned-child.ts'
import type { Trial, Variant } from '../../lib/results.ts'
const root = resolve(import.meta.dir, '../../..')
export const developmentIdentity: Variant = {
  id: 'bun-watch',
  framework: 'bare-bun-watch-fixture',
  version: Bun.version,
  sourceCommit: null,
  runtime: 'Bun',
  runtimeVersion: Bun.version,
  engine: 'none',
  engineVersion: null,
  securityProfile: 'isolated-local-service-no-browser',
  configuration: 'default',
}
export const DEVELOPMENT_SCENARIOS = [
  'warm-dev-launch',
  'backend-edit',
  'failed-edit',
  'service-build',
  'long-command',
  'backend-crash',
] as const
export async function developmentScenario(
  scenario: string
): Promise<Pick<Trial, 'status' | 'reason' | 'correctness' | 'metrics'>> {
  if (!(DEVELOPMENT_SCENARIOS as readonly string[]).includes(scenario))
    return {
      status: 'unsupported',
      reason: 'Bare Bun fixture has no desktop or frontend-HMR implementation',
      correctness: { passed: false, details: 'No desktop behavior simulated' },
      metrics: {},
    }
  // Keep generated projects on the checkout volume. Bun 1.4.4's Windows
  // watcher rejected the system-temp project despite explicit cwd/PWD.
  // No application source is edited: only this newly created private fixture.
  const parent = join(root, '.bunly/edit-fixtures')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, 'project-'))
  const token = randomBytes(24).toString('hex')
  let controller: OwnedChild | undefined
  const metrics: Trial['metrics'] = {}
  const environment = {
    BUNLY_FIXTURE_TOKEN: token,
    BUNLY_FIXTURE_STATE: join(directory, 'state.json'),
    PWD: directory,
    INIT_CWD: directory,
  }
  try {
    for (const file of ['server', 'revision'])
      await copyFile(
        join(root, `benchmarks/fixtures/development/${file}.ts.txt`),
        join(directory, `${file}.ts`)
      )
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'bunly-isolated-edit-fixture', private: true, type: 'module' })
    )
    await writeFile(join(directory, 'state.json'), JSON.stringify({ counter: 0 }), { mode: 0o600 })
    if (scenario === 'backend-crash') {
      controller = ownedChild([process.execPath, '--cwd', directory, './server.ts'], directory, {
        ...environment,
        BUNLY_FIXTURE_ALLOW_FAILURE: '1',
      })
      const initial = await controller.wait((value) => value['event'] === 'ready')
      const origin = new URL(String(initial['origin']))
      assert.equal(origin.hostname, '127.0.0.1')
      assert.equal(origin.protocol, 'http:')
      const headers = { 'x-fixture-token': token }
      const first = await fetch(new URL('/state', origin), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(first.status, 200)
      assert.equal(((await first.json()) as { counter: number }).counter, 1)
      const denied = await fetch(new URL('/crash', origin), {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(denied.status, 403)
      const cursor = controller.cursor(),
        crashStarted = performance.now()
      const response = await fetch(new URL('/crash', origin), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(response.status, 202)
      const exited = await controller.wait((value) => value['event'] === 'exit', cursor)
      assert.equal(
        exited['code'],
        86,
        'The real service must exit with the requested nonzero fault'
      )
      metrics['backendFailureToObserved'] = { value: performance.now() - crashStarted, unit: 'ms' }
      await controller.close()
      const restarted = performance.now()
      controller = ownedChild(
        [process.execPath, '--cwd', directory, './server.ts'],
        directory,
        environment
      )
      const next = await controller.wait((value) => value['event'] === 'ready')
      assert.notEqual(next['instance'], initial['instance'])
      const nextOrigin = new URL(String(next['origin']))
      assert.equal(nextOrigin.hostname, '127.0.0.1')
      assert.equal(nextOrigin.protocol, 'http:')
      const recovered = await fetch(new URL('/state', nextOrigin), {
        headers,
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(recovered.status, 200)
      const actual = (await recovered.json()) as { counter: number; revision: string }
      assert.equal(actual.counter, 1)
      assert.equal(actual.revision, 'initial')
      const disabled = await fetch(new URL('/crash', nextOrigin), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(disabled.status, 404, 'Fault endpoint must be absent without explicit opt-in')
      metrics['backendRestartToUsable'] = { value: performance.now() - restarted, unit: 'ms' }
      metrics['persistedCounter'] = { value: 1, unit: 'count' }
    } else if (scenario === 'service-build') {
      const started = performance.now()
      const result = await Bun.build({
        entrypoints: [join(directory, 'server.ts')],
        outdir: join(directory, 'dist'),
        target: 'bun',
        minify: false,
      })
      assert.equal(result.success, true, result.logs.map(String).join('\n'))
      metrics['serviceBundle'] = { value: performance.now() - started, unit: 'ms' }
      metrics['serviceJavaScriptBytes'] = {
        value: result.outputs.reduce((sum, file) => sum + file.size, 0),
        unit: 'bytes',
      }
      controller = ownedChild(
        [process.execPath, '--cwd', directory, './dist/server.js'],
        directory,
        environment
      )
      const ready: Record<string, unknown> = await controller.wait(
        (value) => value['event'] === 'ready'
      )
      assert.equal(ready['revision'], 'initial')
    } else if (scenario === 'long-command') {
      const started = performance.now()
      const command = join(root, 'benchmarks/fixtures/long-command.ts')
      controller = ownedChild([process.execPath, command, '0'], directory)
      await controller.wait((value) => value['event'] === 'item' && value['sequence'] === 15)
      // A new command resumes from a cursor. This does not preserve a killed shell.
      await controller.close()
      controller = ownedChild([process.execPath, command, '16'], directory)
      let last = -1
      for (let expected = 16; expected < 128; expected++) {
        const item: Record<string, unknown> = await controller.wait(
          (value) => value['event'] === 'item' && value['sequence'] === expected
        )
        assert.equal(item['text'], `command-${expected}`)
        last = expected
      }
      assert.equal(last, 127)
      await controller.wait((value) => value['event'] === 'completed')
      metrics['cancelAndResumeCommand'] = { value: performance.now() - started, unit: 'ms' }
      metrics['resumedItems'] = { value: 112, unit: 'count' }
    } else {
      const started = performance.now()
      controller = ownedChild(
        [process.execPath, '--cwd', directory, '--watch', './server.ts'],
        directory,
        environment
      )
      const initial: Record<string, unknown> = await controller.wait(
        (value) => value['event'] === 'ready'
      )
      async function state(
        ready: Record<string, unknown>,
        increment = false
      ): Promise<Record<string, unknown>> {
        const url = new URL(String(ready['origin']))
        assert.equal(url.hostname, '127.0.0.1')
        assert.equal(url.protocol, 'http:')
        const response = await fetch(new URL('/state', url), {
          method: increment ? 'POST' : 'GET',
          headers: { 'x-fixture-token': token },
          signal: AbortSignal.timeout(2000),
        })
        assert.equal(response.status, 200)
        return (await response.json()) as Record<string, unknown>
      }
      const initialState = await state(initial, true)
      assert.equal(initialState['counter'], 1)
      metrics['watchLaunchToUsable'] = { value: performance.now() - started, unit: 'ms' }
      if (scenario !== 'warm-dev-launch') {
        const after = controller.cursor()
        const editStarted = performance.now()
        if (scenario === 'failed-edit') {
          await writeFile(join(directory, 'revision.ts'), 'export const revision = ;\n')
          await controller.wait(
            (value) =>
              value['event'] === 'diagnostic' &&
              /error|Expected|Syntax/i.test(String(value['text'])),
            after
          )
          metrics['failedEditToDiagnostic'] = { value: performance.now() - editStarted, unit: 'ms' }
        }
        const cursor = controller.cursor()
        const replacement = scenario === 'backend-edit' ? 'edited' : 'repaired'
        const changeStarted = performance.now()
        await writeFile(
          join(directory, 'revision.ts'),
          `export const revision = '${replacement}';\n`
        )
        const next: Record<string, unknown> = await controller.wait(
          (value) => value['event'] === 'ready' && value['revision'] === replacement,
          cursor
        )
        const actual = await state(next)
        assert.equal(actual['revision'], replacement)
        assert.equal(actual['counter'], 1)
        assert.notEqual(
          actual['instance'],
          initialState['instance'],
          'Bun --watch is replacement, not persistent service hot reload'
        )
        metrics[scenario === 'backend-edit' ? 'backendEditToUsable' : 'repairToUsable'] = {
          value: performance.now() - changeStarted,
          unit: 'ms',
        }
        metrics['persistedCounter'] = { value: Number(actual['counter']), unit: 'count' }
        assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).counter, 1)
      }
    }
    return {
      status: 'passed',
      reason:
        'Executed workspace-local bare-Bun fixture; not a Bunly or competitor desktop improvement',
      correctness: {
        passed: true,
        details:
          'Actual source edits/build/command behavior validated; persisted state is fixture-owned disk state, not preserved closures',
      },
      metrics,
    }
  } finally {
    await controller?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }
}
