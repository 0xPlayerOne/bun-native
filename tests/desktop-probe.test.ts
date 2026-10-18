import { expect, test } from 'bun:test';
import { createDesktopProbe, desktopHost, desktopRenderer, assertDesktopReplacement, type DesktopProbe, type DesktopHost, type DesktopRenderer } from '../benchmarks/lib/desktop-probe.ts';
const options = { revision: 'initial', state: 'state-token', counter: 7, framework: 'fixture', version: '1', html: '<!doctype html>', javascript: 'void 0;', timeoutMs: 1000 };
function host(probe: DesktopProbe): DesktopHost { return { launch: probe.configuration.launch, revision: 'initial', instance: 'instance', state: options.state, counter: 7, pid: 12,
  framework: 'fixture', frameworkVersion: '1', runtimeVersion: '1.4.3', engineVersion: null, sandbox: 'unverified' }; }
function renderer(probe: DesktopProbe): DesktopRenderer { return { launch: probe.configuration.launch, revision: 'initial', document: 'document', state: options.state, counter: 7, nativeGlobalsAbsent: true, frameOpportunities: 2 }; }
async function send(probe: DesktopProbe, path: string, value?: unknown, overrides: Record<string, string> = {}): Promise<Response> {
  const page = ['/renderer', '/descriptor'].includes(path);
  return fetch(probe.configuration.origin + path, { method: value === undefined ? 'GET' : 'POST', headers: {
    'x-bunly-probe-token': page ? probe.configuration.rendererToken : probe.configuration.hostToken,
    'content-type': 'application/json', ...(path === '/renderer' ? { origin: probe.configuration.origin } : {}), ...overrides,
  }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
test('desktop reports require strict bounded identities and numeric fields', () => {
  expect(() => desktopHost(null)).toThrow(); expect(() => desktopRenderer([])).toThrow();
  expect(() => desktopHost({ launch: 'a' })).toThrow();
});
test('independent host and renderer acknowledgements complete only matching source and state', async () => {
  const probe = await createDesktopProbe(options);
  try {
    expect((await send(probe, '/renderer', renderer(probe))).status).toBe(409);
    expect((await send(probe, '/host', host(probe))).status).toBe(202);
    const descriptor = await (await send(probe, '/descriptor')).json() as Record<string, unknown>;
    expect(descriptor['revision']).toBe('initial'); expect(JSON.stringify(descriptor)).not.toContain(probe.configuration.hostToken);
    expect((await send(probe, '/renderer', renderer(probe))).status).toBe(202);
    const actual = await probe.completion; expect(actual.host.instance).toBe('instance'); expect(actual.renderer.document).toBe('document');
  } finally { await probe.close(); }
});
test('role tokens are not interchangeable and forged IDs never complete a launch', async () => {
  const probe = await createDesktopProbe(options);
  try {
    expect((await send(probe, '/host', host(probe), { 'x-bunly-probe-token': probe.configuration.rendererToken })).status).toBe(403);
    expect((await send(probe, '/host', { ...host(probe), launch: 'forged' })).status).toBe(400);
    expect((await send(probe, '/descriptor')).status).toBe(409);
  } finally { await probe.close(); }
});
test('a prior generation cannot register or acknowledge a replacement', async () => {
  const a = await createDesktopProbe(options), b = await createDesktopProbe(options);
  try {
    expect(a.configuration.hostToken).not.toBe(b.configuration.hostToken);
    expect((await send(b, '/host', host(a))).status).toBe(400);
    expect((await send(b, '/host', host(b))).status).toBe(202);
    expect((await send(b, '/renderer', renderer(a))).status).toBe(400);
  } finally { await a.close(); await b.close(); }
});
test('renderer Origin and exact Host are enforced without CORS grants', async () => {
  const probe = await createDesktopProbe(options);
  try {
    expect((await send(probe, '/host', host(probe), { origin: probe.configuration.origin })).status).toBe(403);
    expect((await send(probe, '/host', host(probe))).status).toBe(202);
    expect((await send(probe, '/renderer', renderer(probe), { origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await send(probe, '/renderer', renderer(probe), { origin: 'null' })).status).toBe(403);
    expect((await send(probe, '/descriptor', undefined, { host: 'untrusted.example' })).status).toBe(403);
    const response = await send(probe, '/renderer', renderer(probe)); expect(response.headers.get('access-control-allow-origin')).toBeNull();
  } finally { await probe.close(); }
});
test('mismatched loaded revision, persisted state, or runtime version is rejected', async () => {
  const probe = await createDesktopProbe(options);
  try {
    for (const change of [{ revision: 'stale' }, { counter: 0 }, { state: 'other' }, { frameworkVersion: '0' }, { pid: 0 }, { sandbox: 'disabled' }, { extra: true }]) {
      expect((await send(probe, '/host', { ...host(probe), ...change })).status).toBe(400);
    }
    expect((await send(probe, '/host', host(probe))).status).toBe(202);
  } finally { await probe.close(); }
});
test('unsafe page globals or insufficient render opportunities cannot pass', async () => {
  const probe = await createDesktopProbe(options);
  try {
    await send(probe, '/host', host(probe));
    for (const change of [{ nativeGlobalsAbsent: false }, { frameOpportunities: 0 }, { frameOpportunities: 3 }, { revision: 'stale' }, { counter: NaN }, { document: '' }]) {
      expect((await send(probe, '/renderer', { ...renderer(probe), ...change })).status).toBe(400);
    }
  } finally { await probe.close(); }
});
test('duplicate registrations and completions are rejected rather than reused', async () => {
  const probe = await createDesktopProbe(options);
  try {
    await send(probe, '/host', host(probe)); expect((await send(probe, '/host', host(probe))).status).toBe(409);
    await send(probe, '/renderer', renderer(probe)); expect((await send(probe, '/renderer', renderer(probe))).status).toBe(409);
  } finally { await probe.close(); }
});
test('quit is native-only and invalidates further renderer completion', async () => {
  const probe = await createDesktopProbe(options);
  try {
    await send(probe, '/host', host(probe));
    expect((await send(probe, '/command', undefined, { 'x-bunly-probe-token': probe.configuration.rendererToken })).status).toBe(403);
    probe.requestQuit();
    expect((await (await send(probe, '/command')).json() as { command: string }).command).toBe('quit');
    expect((await send(probe, '/renderer', renderer(probe))).status).toBe(410);
  } finally { await probe.close(); }
});
test('missing completion has a finite deadline, never a successful zero time', async () => {
  const probe = await createDesktopProbe({ ...options, timeoutMs: 30 });
  try { await expect(probe.completion).rejects.toThrow('deadline'); expect((await send(probe, '/descriptor')).status).toBe(410); }
  finally { await probe.close(); }
});
test('closing rejects a pending completion and is idempotent', async () => {
  const probe = await createDesktopProbe(options);
  await probe.close(); await probe.close(); await expect(probe.completion).rejects.toThrow('closed');
});
test('invalid methods, content types, queries, and oversized bodies fail closed', async () => {
  const probe = await createDesktopProbe(options);
  try {
    expect((await send(probe, '/host')).status).toBe(405);
    expect((await send(probe, '/host', host(probe), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await send(probe, '/host?token=wrong')).status).toBe(400);
    expect((await send(probe, '/host', { ...host(probe), padding: 'x'.repeat(10000) })).status).toBe(413);
    const response = await fetch(probe.configuration.origin + '/unknown'); expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  } finally { await probe.close(); }
});
test('replacement validation rejects stale modules, unchanged processes/documents and state loss', () => {
  const before = { host: { launch: 'a', revision: 'initial', instance: 'a', state: 'state', counter: 1, pid: 1, framework: 'fixture', frameworkVersion: '1', runtimeVersion: '1', engineVersion: null, sandbox: 'unverified' as const },
    renderer: { launch: 'a', revision: 'initial', document: 'a', state: 'state', counter: 1, nativeGlobalsAbsent: true, frameOpportunities: 2 } };
  const after = { host: { ...before.host, launch: 'b', instance: 'b', revision: 'edited' }, renderer: { ...before.renderer, launch: 'b', document: 'b', revision: 'edited' } };
  expect(() => assertDesktopReplacement(before, after, 'edited')).not.toThrow();
  expect(() => assertDesktopReplacement(before, before, 'edited')).toThrow();
  expect(() => assertDesktopReplacement(before, { ...after, host: { ...after.host, state: 'lost' } }, 'edited')).toThrow();
  expect(() => assertDesktopReplacement(before, { ...after, renderer: { ...after.renderer, document: 'a' } }, 'edited')).toThrow();
});
