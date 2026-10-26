/** Explicit native-window-state profile; historical visible/hidden profiles stay unchanged. */
import assert from 'node:assert/strict'
const [adapter, ...args] = process.argv.slice(2)
assert.equal(Bun.version, '1.4.3')
assert.ok(
  adapter === 'cef' || adapter === 'electron',
  'Use qualify-terminal-window-load cef PREPARED_APP --functional | electron --functional'
)
assert.ok(args.length && !args.includes('--load'))
;(
  globalThis as typeof globalThis & { __bunlyTerminalLoadProfile?: unknown }
).__bunlyTerminalLoadProfile = 'windowed'
if (adapter === 'cef') {
  const [app, ...options] = args
  assert.ok(app && !app.startsWith('--'))
  process.argv = [process.execPath, 'qualify-cef-terminals', app, '--load', ...options]
  await import('./qualify-cef-terminals.ts')
} else {
  process.argv = [process.execPath, 'qualify-electron-terminal-load', ...args]
  await import('./qualify-electron-terminal-load.ts')
}
