import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixtureBytes, terminalChunk, WORKLOAD, checksum } from './data.ts';
import { service } from '../../examples/workbench/service.ts';
const MAX_BODY = 1024 * 1024;
export interface FixtureAssets { html?: string; script?: string; terminalJs?: string; terminalCss?: string }
function escape(value: string): string { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
async function body(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > MAX_BODY) throw new Error('BODY_LIMIT');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function createFixtureServer(assets: FixtureAssets = {}) {
  const token = randomBytes(24).toString('hex');
  const active = new Set<AbortController>();
  let origin = '';
  function send(response: ServerResponse, status: number, data: string | Uint8Array, contentType = 'application/json'): void {
    response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'" });
    response.end(data);
  }
  const server = createServer((request, response) => {
    const controller = new AbortController(); active.add(controller);
    response.once('close', () => { controller.abort(); active.delete(controller); });
    void (async () => {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { send(response, 403, JSON.stringify({ error: 'ORIGIN_DENIED' })); return; }
      const url = new URL(request.url ?? '/', origin);
      const method = request.method ?? 'GET';
      if (url.pathname === '/' && method === 'GET') { send(response, 200, assets.html ?? '<h1>Bunly local fixture server</h1>', 'text/html; charset=utf-8'); return; }
      const staticAssets: Record<string, [string | undefined, string]> = {
        '/ui.js': [assets.script, 'text/javascript'], '/vendor/xterm.js': [assets.terminalJs, 'text/javascript'], '/vendor/xterm.css': [assets.terminalCss, 'text/css'] };
      const asset = staticAssets[url.pathname];
      if (asset && method === 'GET') { send(response, asset[0] === undefined ? 503 : 200, asset[0] ?? 'Fixture dependency not installed', asset[1]); return; }
      if (url.pathname === '/config' && method === 'GET') { const bytes = fixtureBytes(); send(response, 200, JSON.stringify({ ...WORKLOAD, bytes: bytes.length, checksum: checksum(bytes), token })); return; }
      if (url.pathname === '/service' && method === 'GET') { send(response, 200, JSON.stringify(service('workbench'))); return; }
      if (url.pathname === '/page/form' && method === 'GET') {
        send(response, 200, '<!doctype html><title>Local form fixture</title><form method="post" action="/page/submit"><label>Name <input name="name" value="Bunly"></label><button>Submit</button></form><a href="/page/next">Next page</a>', 'text/html; charset=utf-8'); return;
      }
      if (url.pathname === '/page/next' && method === 'GET') { send(response, 200, '<!doctype html><title>Navigation complete</title><h1>Navigation complete</h1>', 'text/html; charset=utf-8'); return; }
      if (url.pathname === '/page/submit' && method === 'POST') {
        const fields = new URLSearchParams(new TextDecoder().decode(await body(request)));
        send(response, 200, '<!doctype html><title>Submitted</title><p>' + escape(fields.get('name') ?? '') + '</p>', 'text/html; charset=utf-8'); return;
      }
      if (url.pathname === '/download' && method === 'GET') {
        response.setHeader('content-disposition', 'attachment; filename="bunly-fixture.bin"');
        send(response, 200, fixtureBytes(), 'application/octet-stream'); return;
      }
      if (url.pathname === '/upload' && method === 'POST') {
        if (request.headers['x-fixture-token'] !== token) { send(response, 403, JSON.stringify({ error: 'TOKEN_DENIED' })); return; }
        const bytes = await body(request); send(response, 200, JSON.stringify({ bytes: bytes.length, checksum: checksum(bytes) })); return;
      }
      if (url.pathname === '/stream' && method === 'GET') {
        const delay = Number(url.searchParams.get('delay') ?? 0);
        if (!Number.isInteger(delay) || delay < 0 || delay > 20) throw new Error('INVALID_DELAY');
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
        for (let i = 0; i < WORKLOAD.count; i++) {
          controller.signal.throwIfAborted();
          if (!response.write(terminalChunk(i))) await once(response, 'drain', { signal: controller.signal });
          if (delay) await sleep(delay, undefined, { signal: controller.signal });
        }
        response.end(); return;
      }
      send(response, 404, JSON.stringify({ error: 'NOT_FOUND' }));
    })().catch(error => {
      if (controller.signal.aborted || response.destroyed) return;
      if (!response.headersSent) send(response, error instanceof Error && error.message === 'BODY_LIMIT' ? 413 : 400, JSON.stringify({ error: 'FIXTURE_REQUEST_FAILED' }));
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.maxConnections = 64;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, token, diagnostics: () => ({ activeRequests: active.size }), async close() {
    for (const controller of active) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
