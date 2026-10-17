import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Ledger, FaultChannel, bounded } from '../benchmarks/lib/lifecycle.ts';
import { MockBackend, startApp } from '../packages/runtime/src/index.ts';
test('ledger detects seeded orphan, listener, descriptor and unresolved request', () => {
  for (const type of ['process', 'listener', 'descriptor', 'request', 'handle'] as const) {
    const ledger = new Ledger(); const resource = ledger.acquire(type, 'fixture');
    assert.throws(() => ledger.assertClean(), /RESOURCE_LEAK/);
    resource.release(); ledger.assertClean(); assert.throws(() => resource.assertLive(), /STALE_HANDLE/);
  }
});
test('bounded queue rejects overload and releases reservations exactly once', () => {
  const ledger = new Ledger(8); const release = ledger.reserve(8);
  assert.throws(() => ledger.reserve(1), /QUEUE_LIMIT/); release(); release(); ledger.assertClean();
});
test('fault channel reports each negative outcome and retires accepted requests', async () => {
  for (const fault of ['exit', 'hang', 'renderer-crash', 'malformed', 'navigation'] as const) {
    const ledger = new Ledger(); const channel = new FaultChannel(ledger);
    await assert.rejects(channel.request('payload', fault, 20)); ledger.assertClean();
  }
});
test('slow consumers retain a bounded queue and complete ordered requests', async () => {
  const ledger = new Ledger(); const channel = new FaultChannel(ledger);
  assert.equal(await channel.request('one', 'slow'), 'one');
  assert.equal(await channel.request('two', 'none'), 'two'); ledger.assertClean();
});
test('external cancellation and never-settling work produce explicit rejection', async () => {
  const controller = new AbortController(); controller.abort(new Error('CANCELLED'));
  let called = false;
  await assert.rejects(bounded(async () => { called = true; return 1; }, 20, controller.signal), /CANCELLED/);
  assert.equal(called, false);
  await assert.rejects(bounded(() => new Promise<never>(() => {}), 10), /DEADLINE/);
});
test('500 real mock lifecycle cycles reject stale handles and retain no resources', async () => {
  const backend = new MockBackend();
  for (let i = 0; i < 500; i++) {
    const app = await startApp(backend, { id: 'test.workbench', title: 'Fixture', url: 'app://workbench/' });
    await app.dispose();
    assert.throws(() => backend.state(app.view));
  }
  await backend.dispose();
  assert.deepEqual(backend.diagnostics(), { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 });
});
