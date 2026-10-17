import { Console } from 'node:console';
import { connectCefBackend, type CefBackend } from './cef.ts';
// Keep stdout exclusively for inherited host protocol before importing application code.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const backend = await connectCefBackend();
try {
  const application = await import(new URL('./application.js', import.meta.url).href) as { default?: (host: CefBackend) => Promise<void> | void };
  if (typeof application.default !== 'function') throw new Error('Application must export a default entry function');
  await application.default(backend);
  await backend.closed;
  process.exit(0);
} catch (error) {
  console.error(error);
  await backend.dispose().catch(() => {});
  process.exit(1);
}
