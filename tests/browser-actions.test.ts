import {it} from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchBrowserAction,
  type AuthorizedView,
  type BrowserAdapter,
  type BrowserCapability,
} from '../packages/runtime/src/browser-actions.ts';
import {collectDiagnosticBundle, redactDiagnosticValue} from '../packages/runtime/src/diagnostics.ts';

const VIEW: AuthorizedView = {
  viewId: 'view-1',
  sessionId: 'session-1',
  epoch: 7,
  origin: 'https://app.example',
  capabilities: ['navigate', 'screenshot', 'snapshot', 'evaluate', 'observe-dom', 'accessibility-tree', 'input'],
  approvedEvaluations: ['document.title'],
};

function fakeAdapter(capabilities: readonly BrowserCapability[] = [
  'navigate', 'screenshot', 'snapshot', 'evaluate', 'observe-dom', 'accessibility-tree', 'input',
]): BrowserAdapter {
  return {
    capabilities: () => capabilities,
    navigate: async () => ({epoch: 8, origin: VIEW.origin}),
    capture: async () => ({bytes: 10, data: 'png'}),
    snapshot: async () => ({title: 'example'}),
    evaluate: async () => 'example',
    observeDom: async () => ({nodes: 1}),
    accessibilityTree: async () => ({role: 'document'}),
    input: async () => ({accepted: true}),
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'req-1',
  target: {viewId: 'view-1', sessionId: 'session-1', epoch: 7},
  action: 'screenshot' as const,
  ...overrides,
});

const POLICY = {maxScreenshotBytes: 1024, debugEnabled: true, productionBuild: false};

it('runs an authorized action and binds it to the view session', async () => {
  const result = await dispatchBrowserAction(request(), fakeAdapter(), {views: [VIEW], authenticated: true}, POLICY);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 'png');
});

it('refuses a request that is not bound to an authorized view and session', async () => {
  const result = await dispatchBrowserAction(
    request({target: {viewId: 'view-1', sessionId: 'other-session', epoch: 7}}),
    fakeAdapter(),
    {views: [VIEW], authenticated: true},
    POLICY,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'unauthorized-target');
});

it('refuses a stale target from a superseded navigation epoch', async () => {
  const result = await dispatchBrowserAction(
    request({target: {viewId: 'view-1', sessionId: 'session-1', epoch: 3}}),
    fakeAdapter(),
    {views: [VIEW], authenticated: true},
    POLICY,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'stale-target');
});

it('reports an unavailable capability as an explicit error', async () => {
  const result = await dispatchBrowserAction(
    request({action: 'accessibility-tree'}),
    fakeAdapter(['navigate', 'screenshot']),
    {views: [VIEW], authenticated: true},
    POLICY,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'unsupported-capability');
});

it('refuses a navigation that leaves the authorized origin', async () => {
  const adapter = fakeAdapter();
  const crossing = {...adapter, navigate: async () => ({epoch: 9, origin: 'https://other.example'})};
  const result = await dispatchBrowserAction(
    request({action: 'navigate', payload: {url: 'https://other.example'}}),
    crossing,
    {views: [VIEW], authenticated: true},
    POLICY,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'cross-origin-frame');
});

it('refuses a navigation that does not advance the epoch', async () => {
  const adapter = fakeAdapter();
  const racing = {...adapter, navigate: async () => ({epoch: 7, origin: VIEW.origin})};
  const result = await dispatchBrowserAction(
    request({action: 'navigate', payload: {url: 'https://app.example/next'}}),
    racing,
    {views: [VIEW], authenticated: true},
    POLICY,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'navigation-race');
});

it('refuses a cancelled request before any adapter call', async () => {
  let called = false;
  const adapter = {...fakeAdapter(), capture: async () => {called = true; return {bytes: 1, data: 'x'};}};
  const result = await dispatchBrowserAction(request(), adapter, {views: [VIEW], authenticated: true, cancelled: () => true}, POLICY);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'cancelled');
  assert.equal(called, false);
});

it('refuses an oversized screenshot', async () => {
  const adapter = {...fakeAdapter(), capture: async () => ({bytes: 4096, data: 'x'})};
  const result = await dispatchBrowserAction(request(), adapter, {views: [VIEW], authenticated: true}, POLICY);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'payload-too-large');
});

it('refuses an evaluation that is not approved for the view', async () => {
  const result = await dispatchBrowserAction(
    request({action: 'evaluate', evaluation: {expression: 'fetch("/x")', approved: true}}),
    fakeAdapter(),
    {views: [VIEW], authenticated: true},
    POLICY,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'evaluation-not-permitted');
});

it('disables the debug surface in a packaged production build', async () => {
  const result = await dispatchBrowserAction(
    request({action: 'evaluate', evaluation: {expression: 'document.title', approved: true}}),
    fakeAdapter(),
    {views: [VIEW], authenticated: true},
    {maxScreenshotBytes: 1024, debugEnabled: true, productionBuild: true},
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'diagnostics-disabled');
});

it('requires an authenticated caller for the debug surface', async () => {
  const result = await dispatchBrowserAction(
    request({action: 'snapshot'}),
    fakeAdapter(),
    {views: [VIEW], authenticated: false},
    POLICY,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'diagnostics-disabled');
});

it('redacts secrets and home paths in a diagnostic bundle', () => {
  const policy = {maxBytes: 4096};
  assert.equal(redactDiagnosticValue('token=abc', policy), '[redacted]');
  assert.equal(redactDiagnosticValue('/Users/someone/notes.txt', policy), '~/someone/notes.txt');
  const bundle = collectDiagnosticBundle(
    [{kind: 'bun-error', message: 'password=hunter2', frame: {file: '/app/x.ts', line: 3, column: 1}}],
    policy,
  );
  assert.equal(bundle.records[0].message, '[redacted]');
  assert.equal(bundle.truncated, false);
});

it('bounds a diagnostic bundle and reports the truncation', () => {
  const bundle = collectDiagnosticBundle(
    Array.from({length: 20}, (_value, index) => ({kind: 'renderer-log' as const, message: `line ${index}`})),
    {maxBytes: 120},
  );
  assert.equal(bundle.truncated, true);
  assert.ok(bundle.bytes <= 120);
  assert.ok(bundle.records.length < 20);
});
