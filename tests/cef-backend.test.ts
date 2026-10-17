import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { CefBackend } from '../packages/runtime/src/cef.ts';
import type { SessionHandle, ViewHandle, WindowHandle } from '../packages/contracts/src/index.ts';
import { nativePeer, turn, type Command } from './helpers/native-peer.ts';
const windowOptions = { title: 'fixture', bounds: { x: 0, y: 0, width: 800, height: 600 } };
async function fixture() {
  const peer = await nativePeer(); let next = 0;
  peer.handle(command => { peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null); if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' }); });
  const backend = new CefBackend(peer.transport);
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'fixture' });
  const window = await backend.createWindow(windowOptions);
  const view = await backend.createView({ session, window, url: 'app://ui/index.html', trust: { kind: 'application', origin: 'app://ui' } });
  return { ...peer, backend, session, window, view };
}
test('CEF resource disposal is idempotent and coalesces simultaneous native requests', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.backend.disposeView(f.view), f.backend.disposeView(f.view)]); await f.backend.disposeView(f.view);
    await Promise.all([f.backend.closeWindow(f.window), f.backend.closeWindow(f.window)]); await f.backend.closeWindow(f.window);
    await Promise.all([f.backend.disposeSession(f.session), f.backend.disposeSession(f.session)]); await f.backend.disposeSession(f.session);
    for (const op of ['view.dispose', 'window.close', 'session.dispose']) assert.equal(f.commands.filter(c => c.op === op).length, 1);
    assert.deepEqual(f.backend.diagnostics(), { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 });
  } finally { await f.backend.dispose(); }
});
test('CEF foreign handles remain rejected even by idempotent disposal methods', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.backend.disposeView({ ...f.view } as ViewHandle), /foreign/);
    await assert.rejects(f.backend.closeWindow({ ...f.window } as WindowHandle), /foreign/);
    await assert.rejects(f.backend.disposeSession({ ...f.session } as SessionHandle), /foreign/);
  } finally { await f.backend.dispose(); }
});
test('CEF shutdown cannot register resources from a late creation response', async () => {
  const peer = await nativePeer(); const backend = new CefBackend(peer.transport);
  const created = backend.createWindow(windowOptions); const disposed = backend.dispose();
  peer.reply(peer.commands[0]!, { id: 1 }); peer.reply(peer.commands[1]!); peer.send({ v: 1, event: 'shutdown' });
  await assert.rejects(created, /disposed/); await disposed; assert.equal(backend.diagnostics().windows, 0);
});
test('CEF simultaneous dispose callers wait for the same shutdown completion', async () => {
  const peer = await nativePeer(); const backend = new CefBackend(peer.transport);
  const first = backend.dispose(); const second = backend.dispose(); assert.strictEqual(first, second);
  let finished = false; void second.then(() => { finished = true; }); await turn(); assert.equal(finished, false);
  peer.reply(peer.commands[0]!); peer.send({ v: 1, event: 'shutdown' }); await first;
});
test('CEF parent identity is revoked before reentrant child-disposal listeners run', async () => {
  const f = await fixture(); const attempts: Promise<unknown>[] = [];
  try {
    f.backend.onEvent(event => { if (event.type === 'disposed' && event.resource === f.view) attempts.push(f.backend.createView({ window: f.window, session: f.session, url: 'app://ui/index.html', trust: { kind: 'remote' } }).catch(error => error)); });
    f.send({ v: 1, event: 'window.closed', target: 2, data: null }); await turn();
    assert.equal(attempts.length, 1); assert.match(String(await attempts[0]), /disposed/);
    assert.equal(f.commands.filter(c => c.op === 'view.create').length, 1);
    await f.backend.closeWindow(f.window);
  } finally { await f.backend.dispose(); }
});
test('CEF owner close racing a view creation cleans up the late child instead of publishing it', async () => {
  const f = await fixture(); let create: Command | undefined; let close: Command | undefined;
  f.handle(command => { if (command.op === 'view.create') create = command; else if (command.op === 'window.close') close = command; else { f.reply(command); if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' }); } });
  const created = f.backend.createView({ window: f.window, session: f.session, url: 'app://ui/index.html', trust: { kind: 'remote' } });
  const rejected = assert.rejects(created, /closing/); const closing = f.backend.closeWindow(f.window); await turn();
  f.reply(create!, { id: 4 }); await rejected; f.reply(close!); await closing;
  assert.equal(f.commands.filter(c => c.op === 'view.dispose' && c.args['id'] === 4).length, 1);
  assert.equal(f.backend.diagnostics().views, 0); await f.backend.dispose();
});
test('CEF close rejection permits retry while already-closed handles remain inert', async () => {
  const f = await fixture(); let rejected = false;
  f.handle(command => { if (command.op === 'window.close' && !rejected) { rejected = true; f.reject(command); } else { f.reply(command); if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' }); } });
  await assert.rejects(f.backend.closeWindow(f.window), /rejection/); await f.backend.closeWindow(f.window); await f.backend.closeWindow(f.window);
  assert.equal(f.commands.filter(c => c.op === 'window.close').length, 2); await f.backend.dispose();
});
test('CEF duplicate session creation and mismatched application grants fail before native calls', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.backend.createSession({ persistence: 'ephemeral', partition: 'fixture' }), /owner/);
    await assert.rejects(f.backend.createView({ window: f.window, session: f.session, url: 'app://ui/index.html', trust: { kind: 'application', origin: 'app://other' } }), /origin/);
    assert.equal(f.commands.filter(c => c.op === 'session.create').length, 1);
  } finally { await f.backend.dispose(); }
});
test('CEF unexpected native exit rejects backend closure and clears retained state', async () => {
  const f = await fixture(); f.backend.observe(() => {}); f.backend.onEvent(() => {});
  f.input.end(); await assert.rejects(f.backend.closed, /disconnected/);
  assert.deepEqual(f.backend.diagnostics(), { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 });
});
test('CEF returned navigation state is detached and stale events cannot revive disposed views', async () => {
  const f = await fixture();
  try {
    const result = await f.backend.navigate(f.view, 'app://ui/index.html');
    (result as { url: string }).url = 'https://invalid.example'; assert.equal(f.backend.state(f.view).url, 'app://ui/index.html');
    await f.backend.disposeView(f.view); f.send({ v: 1, event: 'view.loaded', target: 3, data: { url: 'app://ui/next.html' } }); await turn();
    assert.equal(f.backend.diagnostics().views, 0);
  } finally { await f.backend.dispose(); }
});
