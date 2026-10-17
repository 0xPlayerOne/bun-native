import assert from 'node:assert/strict';
import { MockBackend, startApp } from '../../packages/runtime/src/index.ts';
import { createFixtureServer } from '../fixtures/server.ts';
import { fixtureBytes, checksum } from '../fixtures/data.ts';
import { FaultChannel, Ledger } from './lifecycle.ts';
import type { Trial } from './results.ts';
export const SCENARIOS = ['lifecycle', 'navigation', 'stream-transfer', 'terminal-render', 'fault-contract', 'frontend-hmr', 'backend-edit', 'failed-edit', 'backend-crash', 'renderer-crash', 'cold-install', 'warm-dev-launch', 'app-build', 'signed-release'] as const;
export async function mockScenario(scenario: string): Promise<Pick<Trial, 'status' | 'reason' | 'correctness' | 'metrics'>> {
  const started = performance.now();
  if (scenario === 'lifecycle' || scenario === 'navigation') {
    const backend = new MockBackend();
    try {
      const app = await startApp(backend, { id: 'test.workbench', title: 'Comparison', url: 'app://workbench/' });
      if (scenario === 'navigation') assert.equal((await backend.navigate(app.view, 'https://fixture.invalid/next')).url, 'https://fixture.invalid/next');
      await app.dispose(); assert.throws(() => backend.state(app.view));
      assert.equal(backend.diagnostics().windows + backend.diagnostics().views + backend.diagnostics().sessions, 0);
    } finally { await backend.dispose(); }
  } else if (scenario === 'stream-transfer') {
    const server = await createFixtureServer();
    try {
      const response = await fetch(server.origin + '/stream'); assert.equal(response.status, 200);
      const bytes = new Uint8Array(await response.arrayBuffer()); const expected = fixtureBytes();
      assert.equal(bytes.length, expected.length); assert.equal(checksum(bytes), checksum(expected));
      return { status: 'passed', reason: 'Local HTTP byte fixture only; no terminal rendering or native IPC', correctness: { passed: true, details: 'Complete ordered bytes verified' },
        metrics: { elapsed: { value: performance.now() - started, unit: 'ms' }, bytes: { value: bytes.length, unit: 'bytes' } } };
    } finally { await server.close(); }
  } else if (scenario === 'fault-contract') {
    const ledger = new Ledger(); const channel = new FaultChannel(ledger);
    await assert.rejects(channel.request('test', 'hang', 10), /DEADLINE/); ledger.assertClean();
  } else return { status: 'unsupported', reason: 'Requires a real desktop adapter or later Bunly milestone; not measured by the mock', correctness: { passed: false, details: 'Not implemented in this adapter' }, metrics: {} };
  return { status: 'passed', reason: 'Contract-level mock fixture, not native desktop performance', correctness: { passed: true, details: 'Contract assertions passed and cleanup verified' }, metrics: { elapsed: { value: performance.now() - started, unit: 'ms' } } };
}
