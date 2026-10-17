import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { loadNative } from './native-api.ts';
const [mode, path, scenario = 'normal'] = process.argv.slice(2);
if ((mode !== 'ffi' && mode !== 'napi') || !path) throw new Error('Expected ffi|napi library [normal|hang]');
const api = loadNative(path, mode);
assert.equal(api.markMain(), 0);
const results: Record<string, unknown>[] = [];
const faults = scenario === 'hang' ? ['hang'] as const :
  [...Array.from({ length: 20 }, () => 'none' as const), 'callback', 'none', 'idle-timeout', 'none', 'pre-register-exit', 'none'] as const;
async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Worker lifecycle deadline')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
for (const [generation, fault] of faults.entries()) {
  const worker = new Worker(new URL('./generation-worker.ts', import.meta.url), { workerData: { mode, path, generation, fault } });
  const messages: Record<string, unknown>[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveExit!: (code: number) => void;
  let workerError: Error | undefined;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  // Always attach handlers before blocking in native code.
  worker.on('message', (message: Record<string, unknown>) => {
    messages.push(message);
    if (message['type'] === 'ready') resolveReady();
  });
  worker.on('error', error => { workerError = error; rejectReady(error); });
  worker.on('exit', code => { resolveExit(code); if (!messages.some(m => m['type'] === 'ready')) rejectReady(new Error(`Exited before ready: ${code}`)); });
  const started = performance.now();
  try {
    if (fault === 'pre-register-exit') {
      await assert.rejects(deadline(ready, 3000), /Exited before ready: 23/);
      assert.equal(await deadline(exited, 3000), 23);
      results.push({ generation, fault, expectedFailureObserved: true });
      continue;
    }
    await deadline(ready, 3000);
    worker.postMessage('run');
    const status = api.run(fault === 'idle-timeout' || fault === 'hang' ? 400 : 5000);
    assert.equal(status, fault === 'idle-timeout' || fault === 'hang' ? -1 : 0);
    if (fault === 'hang') {
      // The native loop has returned: revoke dispatch BEFORE terminating its JS owner.
      assert.equal(api.clearCallback(), 0);
      await deadline(worker.terminate(), 3000);
      results.push({ generation, fault, expectedTimeoutObserved: true, dispatchRevokedBeforeTermination: true });
      continue;
    }
    worker.postMessage('release');
    assert.equal(await deadline(exited, 3000), 0);
    assert.equal(workerError, undefined);
    assert.ok(messages.some(m => m['type'] === 'released' && m['generation'] === generation));
    const result = messages.find(m => m['type'] === 'result');
    if (fault === 'idle-timeout') assert.equal(result, undefined);
    else {
      assert.equal(result?.['received'], fault === 'callback' ? 8 : 256);
      if (fault === 'callback') assert.match(String(result?.['error']), /INJECTED_CALLBACK_FAILURE/);
      else { assert.equal(result?.['error'], null); assert.ok(Number(result?.['gcCycles']) >= 15); assert.ok(Number(result?.['ticks']) > 0); }
    }
    results.push({ generation, fault, elapsedMs: performance.now() - started, ...result });
    // Any leftover STOP or data message would change this expected idle timeout.
    assert.equal(api.run(2), -1, 'Native queue must be empty between generations');
  } finally {
    worker.removeAllListeners('message');
    // Already-exited workers return promptly; a live fault is killed by the outer watchdog if necessary.
    await deadline(worker.terminate(), 3000);
  }
}
api.close();
console.log(JSON.stringify({ schema: 1, passed: true, scope: 'same-host qualification fixture; not CEF or production reload', mode, scenario,
  hostPid: process.pid, generations: results.length, results,
  limitations: ['Caught callback faults are not arbitrary native-memory safety.', 'Forced termination requires dispatch revocation after the native loop returns.', 'Whole-process native crashes require the subprocess boundary.'] }));
