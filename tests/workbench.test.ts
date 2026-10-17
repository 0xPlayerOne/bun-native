import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createFixtureServer } from '../benchmarks/fixtures/server.ts';
import { fixtureBytes, checksum, terminalChunk } from '../benchmarks/fixtures/data.ts';
import { mockScenario, SCENARIOS } from '../benchmarks/lib/mock-scenarios.ts';
test('workload bytes are deterministic, bounded and mutation-sensitive', () => {
  const a = fixtureBytes(); const b = fixtureBytes(); assert.deepEqual(a, b);
  b[0] = b[0]! ^ 1; assert.notEqual(checksum(a), checksum(b));
  assert.throws(() => fixtureBytes(100000)); assert.throws(() => terminalChunk(0, 1));
});
test('local fixtures support navigation, safe forms, exact downloads and uploads', async () => {
  const server = await createFixtureServer();
  try {
    assert.match(await (await fetch(server.origin + '/page/next')).text(), /Navigation complete/);
    const form = await fetch(server.origin + '/page/submit', { method: 'POST', body: 'name=%3Cscript%3E' });
    assert.match(await form.text(), /&lt;script&gt;/);
    const bytes = new Uint8Array(await (await fetch(server.origin + '/download')).arrayBuffer());
    assert.deepEqual(bytes, fixtureBytes());
    const upload = await fetch(server.origin + '/upload', { method: 'POST', headers: { 'x-fixture-token': server.token }, body: new Uint8Array(bytes).buffer });
    assert.deepEqual(await upload.json(), { bytes: bytes.length, checksum: checksum(bytes) });
    assert.equal((await fetch(server.origin + '/upload', { method: 'POST', body: 'no token' })).status, 403);
    assert.equal((await fetch(server.origin + '/service', { headers: { Origin: 'https://hostile.invalid' } })).status, 403);
    assert.equal((await fetch(server.origin + '/../../private')).status, 404);
  } finally { await server.close(); }
});
test('stream transfer verifies complete output; terminal rendering is not faked', async () => {
  assert.equal((await mockScenario('stream-transfer')).status, 'passed');
  assert.equal((await mockScenario('terminal-render')).status, 'unsupported');
  assert.equal((await mockScenario('backend-edit')).status, 'unsupported');
});
test('all declared scenarios produce explicit outcomes', async () => {
  for (const scenario of SCENARIOS) assert.ok(['passed', 'unsupported'].includes((await mockScenario(scenario)).status));
});
