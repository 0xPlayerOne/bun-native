import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ownedChild, type OwnedChild } from '../../lib/owned-child.ts';
import type { Trial, Variant } from '../../lib/results.ts';
const root = resolve(import.meta.dir, '../../..');
export const developmentIdentity: Variant = { id: 'bun-watch', framework: 'bare-bun-watch-fixture', version: Bun.version,
  sourceCommit: null, runtime: 'Bun', runtimeVersion: Bun.version, engine: 'none', engineVersion: null,
  securityProfile: 'isolated-local-service-no-browser', configuration: 'default' };
export const DEVELOPMENT_SCENARIOS = ['warm-dev-launch', 'backend-edit', 'failed-edit', 'service-build', 'long-command'] as const;
export async function developmentScenario(scenario: string): Promise<Pick<Trial, 'status' | 'reason' | 'correctness' | 'metrics'>> {
  if (!(DEVELOPMENT_SCENARIOS as readonly string[]).includes(scenario)) return { status: 'unsupported', reason: 'Bare Bun fixture has no desktop or frontend-HMR implementation',
    correctness: { passed: false, details: 'No desktop behavior simulated' }, metrics: {} };
  const directory = await mkdtemp(join(tmpdir(), 'bunly-edit-fixture-'));
  const token = randomBytes(24).toString('hex');
  let controller: OwnedChild | undefined;
  const metrics: Trial['metrics'] = {};
  const environment = { BUNLY_FIXTURE_TOKEN: token, BUNLY_FIXTURE_STATE: join(directory, 'state.json'), PWD: directory, INIT_CWD: directory };
  try {
    for (const file of ['server', 'revision']) await copyFile(join(root, `benchmarks/fixtures/development/${file}.ts.txt`), join(directory, `${file}.ts`));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'bunly-isolated-edit-fixture', private: true, type: 'module' }));
    await writeFile(join(directory, 'state.json'), JSON.stringify({ counter: 0 }), { mode: 0o600 });
    if (scenario === 'service-build') {
      const started = performance.now();
      const result = await Bun.build({ entrypoints: [join(directory, 'server.ts')], outdir: join(directory, 'dist'), target: 'bun', minify: false });
      assert.equal(result.success, true, result.logs.map(String).join('\n'));
      metrics['serviceBundle'] = { value: performance.now() - started, unit: 'ms' };
      metrics['serviceJavaScriptBytes'] = { value: result.outputs.reduce((sum, file) => sum + file.size, 0), unit: 'bytes' };
      controller = ownedChild([process.execPath, '--cwd', directory, './dist/server.js'], directory, environment);
      const ready: Record<string, unknown> = await controller.wait(value => value['event'] === 'ready');
      assert.equal(ready['revision'], 'initial');
    } else if (scenario === 'long-command') {
      const started = performance.now();
      const command = join(root, 'benchmarks/fixtures/long-command.ts');
      controller = ownedChild([process.execPath, command, '0'], directory);
      await controller.wait(value => value['event'] === 'item' && value['sequence'] === 15);
      // A new command resumes from a cursor. This does not preserve a killed shell.
      await controller.close(); controller = ownedChild([process.execPath, command, '16'], directory);
      let last = -1;
      for (let expected = 16; expected < 128; expected++) {
        const item: Record<string, unknown> = await controller.wait(value => value['event'] === 'item' && value['sequence'] === expected);
        assert.equal(item['text'], `command-${expected}`); last = expected;
      }
      assert.equal(last, 127);
      await controller.wait(value => value['event'] === 'completed');
      metrics['cancelAndResumeCommand'] = { value: performance.now() - started, unit: 'ms' };
      metrics['resumedItems'] = { value: 112, unit: 'count' };
    } else {
      const started = performance.now();
      // Explicit cwd and a real project manifest avoid inheriting the caller's
      // project root, especially across Windows drive boundaries.
      controller = ownedChild([process.execPath, '--cwd', directory, '--watch', './server.ts'], directory, environment);
      const initial: Record<string, unknown> = await controller.wait(value => value['event'] === 'ready');
      async function state(ready: Record<string, unknown>, increment = false): Promise<Record<string, unknown>> {
        const url = new URL(String(ready['origin']));
        assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
        const response = await fetch(new URL('/state', url), { method: increment ? 'POST' : 'GET', headers: { 'x-fixture-token': token }, signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 200); return await response.json() as Record<string, unknown>;
      }
      const initialState = await state(initial, true);
      assert.equal(initialState['counter'], 1);
      metrics['watchLaunchToUsable'] = { value: performance.now() - started, unit: 'ms' };
      if (scenario !== 'warm-dev-launch') {
        const after = controller.cursor(); const editStarted = performance.now();
        if (scenario === 'failed-edit') {
          await writeFile(join(directory, 'revision.ts'), 'export const revision = ;\n');
          await controller.wait(value => value['event'] === 'diagnostic' && /error|Expected|Syntax/i.test(String(value['text'])), after);
          metrics['failedEditToDiagnostic'] = { value: performance.now() - editStarted, unit: 'ms' };
        }
        const cursor = controller.cursor(); const replacement = scenario === 'backend-edit' ? 'edited' : 'repaired'; const changeStarted = performance.now();
        await writeFile(join(directory, 'revision.ts'), `export const revision = '${replacement}';\n`);
        const next: Record<string, unknown> = await controller.wait(value => value['event'] === 'ready' && value['revision'] === replacement, cursor);
        const actual = await state(next);
        assert.equal(actual['revision'], replacement); assert.equal(actual['counter'], 1);
        assert.notEqual(actual['instance'], initialState['instance'], 'Bun --watch is replacement, not persistent service hot reload');
        metrics[scenario === 'backend-edit' ? 'backendEditToUsable' : 'repairToUsable'] = { value: performance.now() - changeStarted, unit: 'ms' };
        metrics['persistedCounter'] = { value: Number(actual['counter']), unit: 'count' };
        assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).counter, 1);
      }
    }
    return { status: 'passed', reason: 'Executed isolated bare-Bun fixture; not a Bunly or competitor desktop improvement',
      correctness: { passed: true, details: 'Actual source edits/build/command behavior validated; persisted state is fixture-owned disk state, not preserved closures' }, metrics };
  } finally { await controller?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}
