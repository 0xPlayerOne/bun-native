import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { NativeTransport } from '../packages/runtime/src/native-transport.ts';
import { nativePeer, turn } from './helpers/native-peer.ts';
test('native transport correlates responses and releases resources after clean shutdown', async () => {
  const peer = await nativePeer();
  try {
    const a = peer.transport.call('diagnostics'); const b = peer.transport.call('hello');
    peer.reply(peer.commands[1]!, { text: 'second' }); peer.reply(peer.commands[0]!, { text: 'first' });
    assert.deepEqual(await a, { text: 'first' }); assert.deepEqual(await b, { text: 'second' });
    assert.equal(peer.transport.diagnostics().requests, 0);
  } finally { await peer.stop(); }
  assert.equal(peer.transport.failure, null); assert.ok(peer.input.destroyed); assert.ok(peer.output.destroyed);
});
test('synchronous native write failure rejects all requests and destroys inherited pipes', async () => {
  const input = new PassThrough();
  const output = new Writable({ write() { throw new Error('injected synchronous write'); } });
  const transport = new NativeTransport(input, output);
  input.write('{"v":1,"event":"ready","abi":1}\n'); await transport.ready;
  await assert.rejects(transport.call('window.create'), /injected synchronous write/); await transport.closed;
  assert.deepEqual(transport.diagnostics(), { requests: 0, abandoned: 0, queuedBytes: 0, listeners: 0, closed: true });
  assert.ok(input.destroyed); assert.ok(output.destroyed);
});
test('native request deadlines retire unknown side effects instead of leaking abandoned creations', async () => {
  const peer = await nativePeer(); const pending = peer.transport.call('window.create', {}, undefined, 10);
  await assert.rejects(pending, /deadline/); await peer.transport.closed;
  assert.equal(peer.transport.diagnostics().abandoned, 0); assert.ok(peer.input.destroyed);
});
test('cancelled navigation consumes its late reply without corrupting the next request', async () => {
  const peer = await nativePeer(); const controller = new AbortController();
  try {
    const pending = peer.transport.call('view.navigate', {}, controller.signal); controller.abort();
    await assert.rejects(pending, /abort/i); assert.equal(peer.transport.diagnostics().abandoned, 1);
    peer.reply(peer.commands[0]!); await turn();
    const next = peer.transport.call('diagnostics'); peer.reply(peer.commands[1]!, { pending: 0 });
    assert.deepEqual(await next, { pending: 0 }); assert.equal(peer.transport.diagnostics().abandoned, 0);
  } finally { await peer.stop(); }
});
test('pre-aborted native operations never write a frame', async () => {
  const peer = await nativePeer();
  try { await assert.rejects(peer.transport.call('view.navigate', {}, AbortSignal.abort())); assert.equal(peer.commands.length, 0); }
  finally { await peer.stop(); }
});
test('malformed native errors reject outstanding calls rather than leaving a removed promise unsettled', async () => {
  const peer = await nativePeer(); const pending = peer.transport.call('hello');
  peer.send({ v: 1, id: 1, ok: false, error: { invalid: true } });
  await assert.rejects(pending, /Invalid native error/); assert.equal(peer.transport.diagnostics().requests, 0);
});
test('duplicate responses and pre-readiness events fail the protocol', async () => {
  const peer = await nativePeer(); const pending = peer.transport.call('hello');
  peer.reply(peer.commands[0]!); await pending; peer.reply(peer.commands[0]!); await peer.transport.closed;
  assert.match(String(peer.transport.failure), /duplicate/);
  const input = new PassThrough(); const output = new PassThrough(); const transport = new NativeTransport(input, output);
  input.write('{"v":1,"event":"view.loaded","target":1}\n');
  await assert.rejects(transport.ready, /before readiness/); assert.ok(output.destroyed);
});
test('UTF-8 may straddle chunks but invalid UTF-8 and truncated frames fail closed', async () => {
  const peer = await nativePeer(); const events: unknown[] = []; peer.transport.onEvent(event => events.push(event));
  const bytes = Buffer.from('{"v":1,"event":"view.console","target":1,"data":{"message":"éλ"}}\n');
  const cut = bytes.indexOf(Buffer.from('é')) + 1; peer.input.write(bytes.subarray(0, cut)); peer.input.write(bytes.subarray(cut));
  await turn(); assert.equal(events.length, 1); await peer.stop();
  const invalid = await nativePeer(); invalid.input.write(Buffer.from([0xff, 10])); await invalid.transport.closed; assert.ok(invalid.transport.failure);
  const truncated = await nativePeer(); truncated.input.end('{"v":1'); await truncated.transport.closed;
  assert.match(String(truncated.transport.failure), /Truncated/);
});
test('capacity checks do not write oversized frames or leak pending state', async () => {
  const peer = await nativePeer();
  try {
    await assert.rejects(peer.transport.call('hello', { text: 'x'.repeat(65536) }), /capacity/);
    const circular: Record<string, unknown> = {}; circular['self'] = circular;
    await assert.rejects(peer.transport.call('hello', circular)); assert.equal(peer.commands.length, 0);
    assert.equal(peer.transport.diagnostics().requests, 0);
  } finally { await peer.stop(); }
});
