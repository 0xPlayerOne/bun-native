interface TerminalRenderer { open(element: HTMLElement): void; write(data: Uint8Array | string, callback?: () => void): void; dispose(): void }
interface FixtureConfig { count: number; width: number; bytes: number; checksum: number; token: string }
interface HostBridge { finish(result: Record<string, unknown>): Promise<void>; readonly sandboxed: boolean }
const win = window as unknown as { Terminal: new (options: Record<string, unknown>) => TerminalRenderer; workbenchHost?: HostBridge };
const status = document.getElementById('status')!;
const output = document.getElementById('results')!;
const terminal = new win.Terminal({ cols: 96, rows: 18, scrollback: 2048 });
terminal.open(document.getElementById('terminal')!);
const inputDelays: number[] = [];
let controller: AbortController | undefined;
let running = false;
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function hash(bytes: Uint8Array, initial: number): number { let value = initial; for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0; return value; }
async function stream(): Promise<Record<string, unknown>> {
  if (running) throw new Error('Stream already running');
  running = true; controller = new AbortController();
  const started = performance.now(); let bytes = 0; let checksum = 2166136261;
  try {
    const config = await (await fetch('/config')).json() as FixtureConfig;
    const response = await fetch('/stream', { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('Missing fixture stream');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.length; checksum = hash(next.value, checksum);
        await new Promise<void>(resolve => terminal.write(next.value, resolve));
      }
    } finally { reader.releaseLock(); }
    await frame(); await frame();
    if (bytes !== config.bytes || checksum !== config.checksum) throw new Error('Dropped or reordered terminal bytes');
    return { passed: true, bytes, checksum, terminalConsumedAndPaintedMs: performance.now() - started, inputDelays };
  } finally { running = false; }
}
document.getElementById('stream')!.addEventListener('click', () => {
  status.textContent = 'Streaming';
  void stream().then(result => { output.textContent = JSON.stringify(result, null, 2); status.textContent = 'Complete'; })
    .catch(error => { output.textContent = String(error); status.textContent = 'Failed or cancelled'; });
});
document.getElementById('cancel')!.addEventListener('click', () => controller?.abort());
document.getElementById('navigate')!.addEventListener('click', () => { (document.getElementById('preview') as HTMLIFrameElement).src = '/page/next'; });
document.getElementById('input')!.addEventListener('input', () => { const started = performance.now(); requestAnimationFrame(() => inputDelays.push(performance.now() - started)); });
window.addEventListener('pagehide', () => { controller?.abort(); terminal.dispose(); }, { once: true });
async function auto(): Promise<void> {
  await frame(); await frame(); status.textContent = 'Ready';
  const scenario = new URL(location.href).searchParams.get('scenario');
  if (!scenario || !win.workbenchHost) return;
  try {
    const result = scenario === 'terminal-render' ? await stream() : { passed: true, frameReadyMs: performance.now() };
    await win.workbenchHost.finish({ ...result, scenario, sandboxed: win.workbenchHost.sandboxed });
  } catch (error) { await win.workbenchHost.finish({ passed: false, scenario, error: String(error) }); }
}
void auto();
export {};
