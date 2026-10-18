import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observedCommand } from '../benchmarks/lib/observed-command.ts';
for (const delay of [0, 5, 100]) test(`cancellation buffered before slow Python startup (${delay} ms) still records cleanup`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-observer-startup-'));
  let reaped = false;
  try {
    // A trusted Python wrapper delays loading the real observer. No interpreter
    // policy/startup hook is replaced, and the target command is unchanged.
    const wrapper = 'import runpy,sys,time;from pathlib import Path;t=time.monotonic();time.sleep(0.75);Path(sys.argv[1],"startup.txt").write_text(str(time.monotonic()-t));sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name="__main__")';
    const controller = new AbortController();
    const child = observedCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], { cwd: directory,
      output: join(directory, 'report.json'), timeoutMs: 3000, signal: controller.signal,
      observerCommand: [process.env['PYTHON'] ?? 'python', '-c', wrapper, directory] });
    const timer = setTimeout(() => controller.abort(), delay);
    const result = await child.result; clearTimeout(timer);
    reaped = result.cleanupSurvivors.length === 0;
    expect(Number(await readFile(join(directory, 'startup.txt'), 'utf8'))).toBeGreaterThanOrEqual(0.5);
    expect(result.cancelled).toBe(true); expect(result.timedOut).toBe(false);
    expect(result.observedOrphans).toEqual([]); expect(result.cleanupSurvivors).toEqual([]);
  } finally {
    // A failure to read a report must not delete files beneath unknown work.
    if (reaped) await rm(directory, { recursive: true, force: true });
  }
}, 15000);
