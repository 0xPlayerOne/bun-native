import assert from 'node:assert/strict';
import type { CefBackend } from '../../packages/runtime/src/cef.ts';
export default async function main(backend: CefBackend): Promise<void> {
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 5);
  const pageResult = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Packaged module did not complete')), 10000);
    const remove = backend.observe(event => {
      if (event.event === 'view.console' && event.data?.['message'] === 'BUNLY_ASSET_TEST_OK') { clearTimeout(deadline); remove(); resolve(); }
    });
  });
  try {
    const session = await backend.createSession({ partition: 'smoke', persistence: 'ephemeral' });
    const window = await backend.createWindow({ title: 'Bunly CEF', bounds: { x: 0, y: 0, width: 960, height: 640 } });
    const view = await backend.createView({ window, session, url: 'app://ui/index.html', trust: { kind: 'application', origin: 'app://ui' } });
    await pageResult;
    assert.ok(ticks > 0, 'Bun timers must progress while CEF runs');
    await backend.resizeWindow(window, 1000, 700);
    const second = await backend.createWindow({ title: 'Bunly second window', bounds: { x: 30, y: 30, width: 600, height: 400 } });
    const other = await backend.createView({ window: second, session, url: 'app://ui/next.html', trust: { kind: 'application', origin: 'app://ui' } });
    await backend.navigate(other, 'app://ui/index.html');
    await backend.closeWindow(second);
    await assert.rejects(backend.navigate(other, 'app://ui/next.html'));
    await backend.navigate(view, 'app://ui/next.html');
    await assert.rejects(backend.disposeSession(session));
    console.log(JSON.stringify({ event: 'bunly.native.smoke', passed: true, timers: ticks, diagnostics: await backend.nativeDiagnostics() }));
    await backend.dispose();
  } finally { clearInterval(timer); }
}
