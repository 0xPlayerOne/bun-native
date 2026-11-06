/**
 * Real macOS application menu bar qualification (#239), in the hosted runner's
 * GUI session. The menu bar is read and operated only through an independent
 * Accessibility oracle (tests/native/macos-menu-oracle.m) that never links
 * GPUI: it dumps the host process's AXMenuBar and performs AXPress on items by
 * title, as an assistive client would. When the runner does not trust the
 * oracle for Accessibility the menu bar contents and selections are recorded
 * as unverified, never assumed; the protocol, grant and lifetime checks still
 * run against the real host.
 */
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  type AppMenuItemEvent,
  type MenuOptions,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_APP_MENU_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_APP_MENU_MODE']
const oracle = process.env['BUN_NATIVE_MACOS_MENU_ORACLE']
if (
  process.platform !== 'darwin' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !oracle ||
  !isAbsolute(oracle)
)
  throw new Error(
    'macOS, an evidence directory, the host, the mode and the menu oracle are required'
  )
const host = executable
const menuOracle = oracle

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const raw: Record<string, unknown[]> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}
const keep = (name: string, value: unknown) => {
  ;(raw[name] ??= []).push(value)
}

async function run(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function waitFor(check: () => boolean, description: string, timeout = 5_000) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(25)
  }
}

/** The host is this process's direct child; its executable is the host path. */
async function hostPid(): Promise<number> {
  const children = (await run(['pgrep', '-P', String(process.pid)])).stdout
    .split('\n')
    .filter(Boolean)
  for (const child of children) {
    const command = (await run(['ps', '-o', 'comm=', '-p', child])).stdout
    if (command === host || command.endsWith('/bun-native-host')) return Number(child)
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

interface AXEntry {
  role: string
  title: string
  enabled: boolean | number | null
  mark: string
  key: string
  modifiers: number | null
  items: AXEntry[]
}

async function dump(pid: number, label: string): Promise<AXEntry[]> {
  const result = await run([menuOracle, 'dump', String(pid)])
  if (result.code !== 0) throw new Error('Menu oracle dump failed: ' + result.stderr)
  const bar = JSON.parse(result.stdout) as AXEntry[]
  keep(label, bar)
  return bar
}

/** The application's menus: AppKit lists the system Apple menu first. */
function appMenus(bar: AXEntry[]): AXEntry[] {
  return bar.filter((entry) => entry.role === 'AXMenuBarItem' && entry.title !== 'Apple')
}

function titles(entries: AXEntry[]): string[] {
  return entries.map((entry) => entry.title)
}

function allTitles(entries: AXEntry[]): string[] {
  return entries.flatMap((entry) => [entry.title, ...allTitles(entry.items)])
}

async function press(pid: number, path: string[]): Promise<{ code: number; stderr: string }> {
  const result = await run([menuOracle, 'press', String(pid), ...path])
  keep('press', { path, ...result })
  return result
}

const FIRST: MenuOptions[] = [
  {
    title: 'Qualification',
    items: [
      { kind: 'item', id: 'app.about', label: 'About Qualification' },
      { kind: 'separator' },
      {
        kind: 'item',
        id: 'app.quit',
        label: 'Quit Qualification',
        shortcut: { key: 'q', platform: true },
      },
    ],
  },
  {
    title: 'File',
    items: [
      {
        kind: 'item',
        id: 'file.open',
        label: 'Open Document',
        shortcut: { key: 'o', platform: true },
      },
      {
        kind: 'submenu',
        label: 'Recent',
        items: [{ kind: 'item', id: 'recent.notes', label: 'notes.txt', checked: true }],
      },
      {
        kind: 'item',
        id: 'file.export',
        label: 'Export',
        enabled: false,
        shortcut: { key: 'e', platform: true, shift: true },
      },
    ],
  },
]

const SECOND: MenuOptions[] = [
  {
    title: 'Qualification',
    items: [{ kind: 'item', id: 'second.about', label: 'About Second' }],
  },
  {
    title: 'Edit',
    items: [
      {
        kind: 'item',
        id: 'edit.undo',
        label: 'Undo Change',
        shortcut: { key: 'z', platform: true },
      },
    ],
  },
]

async function deniedByDefault() {
  const app = await createApplication({ executable: host })
  try {
    assert.deepEqual(app.serviceCapabilities.appMenu, {
      availability: 'available',
      permission: 'deny',
      scope: 'application',
      backend: 'appkit',
    })
    await assert.rejects(
      app.setMenuBar(FIRST, () => {}),
      (error: unknown) =>
        error instanceof NativeServiceError &&
        error.service === 'app_menu' &&
        error.code === 'permission_denied'
    )
    record('deniedByDefault', { permission: 'deny' })
  } finally {
    await app.shutdown()
  }
}

async function granted(trusted: boolean) {
  const app = await createApplication({ executable: host, permissions: { appMenu: 'allow' } })
  try {
    assert.deepEqual(app.serviceCapabilities.appMenu, {
      availability: 'available',
      permission: 'allow',
      scope: 'application',
      backend: 'appkit',
    })
    const window = await app.openWindow({ title: 'Menu qualification' })
    const pid = await hostPid()
    const first: AppMenuItemEvent[] = []
    const firstBar = await app.setMenuBar(FIRST, (event) => {
      first.push(event)
    })
    record('firstSet', { active: firstBar.active })
    if (trusted) {
      const bar = appMenus(await dump(pid, 'first'))
      // AppKit shows the first menu under the process name, not its title.
      assert.deepEqual(titles(bar).slice(1), ['File'])
      assert.equal(bar.length, 2)
      assert.deepEqual(titles(bar[0]!.items), ['About Qualification', '', 'Quit Qualification'])
      const quit = bar[0]!.items[2]!
      assert.equal(quit.key.toLowerCase(), 'q')
      assert.equal(quit.modifiers, 0, 'Command alone')
      const [open, recent, exported] = bar[1]!.items
      assert.equal(open?.title, 'Open Document')
      assert.equal(open?.key.toLowerCase(), 'o')
      assert.equal(recent?.title, 'Recent')
      assert.deepEqual(titles(recent!.items), ['notes.txt'])
      assert.notEqual(recent!.items[0]!.mark, '', 'checked items carry a mark')
      assert.equal(exported?.title, 'Export')
      assert.equal(Boolean(exported?.enabled), false)
      assert.equal(exported?.key.toLowerCase(), 'e')
      assert.equal(exported?.modifiers, 1, 'Shift with Command')
      record('firstBarRead', { menus: titles(bar), oracle: 'AXMenuBar' })

      assert.equal((await press(pid, ['File', 'Open Document'])).code, 0)
      await waitFor(() => first.length === 1, 'the Open Document selection')
      assert.equal(first[0]!.itemId, 'file.open')
      assert.equal(first[0]!.menuBar, firstBar)
      assert.equal((await press(pid, ['File', 'Recent', 'notes.txt'])).code, 0)
      await waitFor(() => first.length === 2, 'the nested selection')
      assert.equal(first[1]!.itemId, 'recent.notes')
      // A disabled item never reports, whether or not AppKit performs the press.
      await press(pid, ['File', 'Export'])
      await Bun.sleep(500)
      assert.equal(first.length, 2)
      record('selectionsDelivered', { items: first.map((event) => event.itemId) })
    }

    const second: AppMenuItemEvent[] = []
    const secondBar = await app.setMenuBar(SECOND, (event) => {
      second.push(event)
    })
    assert.equal(firstBar.active, false)
    assert.equal(first.at(-1)?.signal.aborted ?? true, true)
    if (trusted) {
      const bar = appMenus(await dump(pid, 'second'))
      assert.deepEqual(titles(bar).slice(1), ['Edit'])
      assert.deepEqual(titles(bar[0]!.items), ['About Second'])
      assert(!allTitles(bar).includes('Open Document'), 'the replaced bar is gone')
      assert.notEqual((await press(pid, ['File', 'Open Document'])).code, 0)
      assert.equal((await press(pid, ['Edit', 'Undo Change'])).code, 0)
      await waitFor(() => second.length === 1, 'the second bar selection')
      assert.equal(second[0]!.itemId, 'edit.undo')
      assert.equal(first.length, 2, 'the replaced bar delivers nothing')
      record('replacementRevokes', { menus: titles(bar), firstActive: firstBar.active })
    } else record('replacementRevokes', { firstActive: firstBar.active })

    // Windows do not own the bar.
    await window.close()
    assert.equal(secondBar.active, true)
    await secondBar.clear()
    assert.equal(secondBar.active, false)
    if (trusted) {
      const bar = await dump(pid, 'cleared')
      const remaining = allTitles(appMenus(bar))
      for (const title of ['File', 'Edit', 'About Second', 'Undo Change'])
        assert(!remaining.includes(title), title + ' was removed')
      record('clearRemoves', { remaining })
    } else record('clearRemoves', { active: secondBar.active })

    const last = await app.setMenuBar(FIRST, () => {})
    await app.shutdown()
    assert.equal(last.active, false)
    await assert.rejects(
      app.setMenuBar(FIRST, () => {}),
      NativeStateError
    )
    record('shutdownRevokes', { active: last.active })
  } finally {
    await app.shutdown().catch(() => {})
  }
}

const trust = await run([menuOracle, 'trusted'])
assert.equal(trust.code, 0, trust.stderr)
const trusted = (JSON.parse(trust.stdout) as { trusted: boolean }).trusted === true
record('accessibilityTrusted', trusted)
await deniedByDefault()
await granted(trusted)

const status = trusted ? 'verified' : 'unverified'
writeFileSync(
  join(output, 'app-menu.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      status,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      platform: process.platform,
      darwin: release(),
      oracle: trusted
        ? 'Accessibility AXMenuBar dump and AXPress (tests/native/macos-menu-oracle.m)'
        : 'unverified: the runner does not trust the oracle for Accessibility',
      outcomes,
      raw,
    },
    null,
    2
  ) + '\n'
)
console.log(`Application menu qualification ${status}: ${Object.keys(outcomes).length} outcomes`)
