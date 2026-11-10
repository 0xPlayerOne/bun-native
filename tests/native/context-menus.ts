/**
 * Real OS context menu qualification against the native host. On macOS the
 * host pops up an `NSMenu` over the owner view and an independent
 * Accessibility oracle (macos-context-menu-oracle.m) reads and presses it.
 * On Windows the host tracks a Win32 pop-up menu and an independent UI
 * Automation oracle (windows-context-menu-oracle.ps1) reads and invokes it.
 * Neither oracle loads GPUI, so a chosen item is a real accessibility
 * invoke, not a synthesized host event.
 */
import { createApplication, NativeServiceError, NativeStateError } from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const macOS = process.platform === 'darwin'
const output = process.env['BUN_NATIVE_CONTEXT_MENU_EVIDENCE']
const host = process.env['BUN_NATIVE_HOST']
const oracle = process.env['BUN_NATIVE_CONTEXT_MENU_ORACLE']
if (
  (process.platform !== 'win32' && !macOS) ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  !oracle ||
  !isAbsolute(oracle)
)
  throw new Error(
    'OS context menus need a Windows or macOS desktop, evidence directory, host and oracle'
  )

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

/** The host is this process's direct child. */
let hostPid: number | undefined
async function pid(): Promise<number> {
  if (hostPid !== undefined) return hostPid
  const children = (await run(['pgrep', '-P', String(process.pid)])).stdout
    .split('\n')
    .filter(Boolean)
  for (const child of children) {
    const command = (await run(['ps', '-o', 'comm=', '-p', child])).stdout
    if (command === host || command.endsWith('/bun-native-host')) return (hostPid = Number(child))
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

/** find | press | cancel | absent, by the title of a top-level item of the open menu. */
async function ui(command: string, title: string, path: string[] = []): Promise<string> {
  const argv = macOS
    ? [oracle!, command === 'escape' ? 'cancel' : command, String(await pid()), title, ...path]
    : [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        oracle!,
        '-Command',
        command === 'press' ? 'invoke' : command,
        '-Title',
        title,
        ...(path.length === 2 ? ['-Submenu', path[0]!, '-Name', path[1]!] : []),
        ...(path.length === 1 ? ['-Name', path[0]!] : []),
        ...(path.length === 0 && command === 'press' ? ['-Name', title] : []),
      ]
  const result = await run(argv)
  if (result.code !== 0)
    throw new Error(`oracle ${command} exited ${result.code}: ${result.stderr}`)
  return result.stdout
}

const items = [
  {
    kind: 'item',
    id: 'edit.copy',
    label: 'Copy',
    shortcut: { key: 'c', platform: !!macOS, control: !macOS },
  },
  { kind: 'item', id: 'edit.paste', label: 'Paste' },
  { kind: 'separator' },
  {
    kind: 'submenu',
    label: 'Share',
    items: [
      { kind: 'item', id: 'share.mail', label: 'Mail' },
      { kind: 'item', id: 'share.link', label: 'Copy Link' },
    ],
  },
  { kind: 'item', id: 'view.wrap', label: 'Word Wrap', checked: true },
  { kind: 'item', id: 'edit.delete', label: 'Delete', enabled: false },
] as const
const at = { x: 40, y: 40 }

const app = await createApplication({ executable: host! })
let failure: unknown
try {
  assert.equal(app.serviceCapabilities.contextMenus.availability, 'available')
  record('capability', app.serviceCapabilities.contextMenus)
  const window = await app.openWindow({ title: 'Context menu owner', width: 480, height: 320 })

  // 1. The OS shows the given items with their state; pressing one answers it.
  {
    const pending = window.showContextMenu(items, at)
    const shown = await ui('find', 'Copy')
    for (const label of ['Copy', 'Paste', 'Share', 'Word Wrap', 'Delete'])
      assert.ok(shown.includes(label), `${label} missing from ${shown}`)
    record('shownItems', JSON.parse(shown))
    await ui('press', 'Paste', [])
    assert.equal(await pending, 'edit.paste')
    await ui('absent', 'Copy')
    record('itemChosen', 'edit.paste')
  }

  // 2. An item inside a submenu answers with its own id.
  {
    const pending = window.showContextMenu(items, at)
    await ui('find', 'Copy')
    await ui('press', macOS ? 'Share' : 'Copy', macOS ? ['Copy Link'] : ['Share', 'Copy Link'])
    assert.equal(await pending, 'share.link')
    await ui('absent', 'Copy')
    record('nestedChosen', 'share.link')
  }

  // 3. Escape dismisses the menu with no item.
  {
    const pending = window.showContextMenu(items, at)
    await ui('find', 'Copy')
    const how = await ui('escape', 'Copy')
    assert.equal(await pending, null)
    await ui('absent', 'Copy')
    record('escapeDismisses', how)
  }

  // 4. Abort closes the OS menu; a second menu is refused while one is open.
  {
    const controller = new AbortController()
    const pending = window.showContextMenu(items, at, { signal: controller.signal })
    await ui('find', 'Copy')
    await assert.rejects(
      window.showContextMenu(items, at),
      (error: unknown) => error instanceof NativeServiceError && error.code === 'limit_exceeded'
    )
    controller.abort()
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof NativeServiceError && error.code === 'cancelled'
    )
    await ui('absent', 'Copy')
    record('abortCloses', true)
  }

  // 5. Closing the owner ends a live menu and rejects its caller.
  {
    const closing = await app.openWindow({
      title: 'Context menu closing owner',
      width: 320,
      height: 200,
    })
    const pending = closing.showContextMenu(items, at)
    await ui('find', 'Copy')
    const rejected = assert.rejects(
      pending,
      (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
    )
    await closing.close()
    await rejected
    await ui('absent', 'Copy')
    record('ownerCloseEndsMenu', true)
  }

  // 6. Shutdown ends a live menu and the host exits cleanly.
  const live = window.showContextMenu(items, at)
  live.catch(() => {})
  await ui('find', 'Copy')
  await app.shutdown()
  await app.closed
  record('shutdownEndsMenu', true)
} catch (error) {
  failure = error
  throw error
} finally {
  writeFileSync(
    join(output!, 'context-menus.json'),
    JSON.stringify({ platform: process.platform, outcomes, failed: failure !== undefined }, null, 2)
  )
  if (failure !== undefined) await app.shutdown().catch(() => {})
}
