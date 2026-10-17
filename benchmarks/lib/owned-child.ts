import { setTimeout as sleep } from 'node:timers/promises';
/** Bounded controller for trusted test fixtures, not a production process supervisor. */
export function ownedChild(command: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const records: { sequence: number; value: Record<string, unknown> }[] = [];
  let sequence = 0; let outputBytes = 0; let diagnostic = ''; let closed = false; let failure: Error | undefined;
  const changes = new Set<() => void>();
  const notify = () => { for (const listener of changes) listener(); };
  function record(value: Record<string, unknown>): void {
    records.push({ sequence: ++sequence, value });
    if (records.length > 1024) { failure = new Error('Fixture record limit exceeded'); child.kill(); }
    notify();
  }
  async function drain(stream: ReadableStream<Uint8Array>, stderr: boolean): Promise<void> {
    const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = '';
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        outputBytes += next.value.byteLength;
        if (outputBytes > 256 * 1024) { failure = new Error('Fixture output limit exceeded'); child.kill(); notify(); break; }
        const text = decoder.decode(next.value, { stream: true });
        if (stderr) { diagnostic = (diagnostic + text).slice(-32000); record({ event: 'diagnostic', text }); continue; }
        pending += text;
        for (;;) {
          const index = pending.indexOf('\n'); if (index < 0) break;
          const line = pending.slice(0, index); pending = pending.slice(index + 1);
          try { const value: unknown = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) record(value as Record<string, unknown>); }
          catch { diagnostic = (diagnostic + line + '\n').slice(-32000); }
        }
      }
    } catch (error) { if (!closed) { failure = error instanceof Error ? error : new Error(String(error)); notify(); } }
    finally { reader.releaseLock(); }
  }
  const readers = [drain(child.stdout, false), drain(child.stderr, true)];
  void child.exited.then(code => { record({ event: 'exit', code }); });
  return {
    pid: child.pid, cursor: () => sequence, diagnostics: () => diagnostic,
    async wait(predicate: (value: Record<string, unknown>) => boolean, after = 0, timeoutMs = 8000) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new Error('Invalid fixture timeout');
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Fixture event deadline exceeded: ' + diagnostic.slice(-2000))), timeoutMs);
        function finish(error?: Error, value?: Record<string, unknown>): void {
          clearTimeout(timer); changes.delete(check);
          if (error) reject(error); else resolve(value!);
        }
        function check(): void {
          if (failure) { finish(failure); return; }
          const match = records.find(item => item.sequence > after && predicate(item.value));
          if (match) finish(undefined, match.value);
          else if (closed) finish(new Error('Fixture closed before expected event'));
        }
        changes.add(check); check();
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true; notify();
      if (child.exitCode === null) child.kill();
      const exit = await Promise.race([child.exited.then(() => true), sleep(2000).then(() => false)]);
      if (!exit) { child.kill('SIGKILL'); await child.exited; }
      await Promise.race([Promise.all(readers), sleep(1000)]);
      if (changes.size) throw new Error('Fixture retained waiters');
    },
  };
}
