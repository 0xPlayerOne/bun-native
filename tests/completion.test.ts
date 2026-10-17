import { test, expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createFixtureServer } from '../benchmarks/fixtures/server.ts';
import { completionChannel } from '../benchmarks/lib/completion.ts';
test('completion channel rejects invalid configuration', () => {
  expect(() => completionChannel({ token: 'x', scenario: 'app-launch' })).toThrow();
  expect(() => completionChannel({ token: 'a'.repeat(48), scenario: 'app-launch', timeoutMs: 0 })).toThrow();
});
test('completion requires separate token, exact origin and matching scenario', async () => {
  const token = randomBytes(24).toString('hex');
  const server = await createFixtureServer({}, { completion: { token, scenario: 'app-launch', timeoutMs: 100 } });
  try {
    const url = server.origin + '/__benchmark/completion';
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { 'x-benchmark-token': token }, body: '{}' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { 'x-benchmark-token': token, origin: server.origin }, body: JSON.stringify({ scenario: 'wrong', passed: true }) })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers: { 'x-benchmark-token': token, origin: 'https://example.com' }, body: '{}' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { 'x-benchmark-token': token, origin: server.origin }, body: 'x'.repeat(65537) })).status).toBe(413);
  } finally { await server.close(); }
});
test('completion wakes an existing consumer once and retains failed results honestly', async () => {
  const token = randomBytes(24).toString('hex');
  const server = await createFixtureServer({}, { completion: { token, scenario: 'app-launch', timeoutMs: 1000 } });
  try {
    const url = server.origin + '/__benchmark/completion';
    const waiting = fetch(url, { headers: { 'x-benchmark-token': token } });
    const value = { scenario: 'app-launch', passed: false, error: 'seeded failure' };
    const post = () => fetch(url, { method: 'POST', headers: { 'x-benchmark-token': token, origin: server.origin }, body: JSON.stringify(value) });
    expect((await post()).status).toBe(202);
    expect(await (await waiting).json()).toEqual(value);
    expect((await post()).status).toBe(409);
    expect(await (await fetch(url, { headers: { 'x-benchmark-token': token } })).json()).toEqual(value);
  } finally { await server.close(); }
});
test('missing completion has a bounded deadline and no fake success', async () => {
  const token = randomBytes(24).toString('hex');
  const server = await createFixtureServer({}, { completion: { token, scenario: 'app-launch', timeoutMs: 20 } });
  try { expect((await fetch(server.origin + '/__benchmark/completion', { headers: { 'x-benchmark-token': token } })).status).toBe(408); }
  finally { await server.close(); }
});
