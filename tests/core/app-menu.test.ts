import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  ProtocolError,
  type AppMenuItemEvent,
  type MenuEntryOptions,
  type MenuOptions,
  type NativeApplication,
  type ServicePermissions,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ALLOW: ServicePermissions = { appMenu: 'allow' }

async function withMenu(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'hold',
  permissions: ServicePermissions = ALLOW
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-app-menu-peer-'))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, 'app-menu-peer.ts'), directory, mode],
      permissions,
      requestTimeoutMs: 2_000,
    })
    await run(app, directory)
  } finally {
    await app?.shutdown().catch(() => {})
    await app?.closed.catch(() => {})
    if (app) expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
    rmSync(directory, { recursive: true, force: true })
  }
}

function requests(directory: string) {
  const path = join(directory, 'requests.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((value) => value['type'] === 'set_app_menu')
}

async function until(condition: () => boolean) {
  for (let index = 0; index < 100 && !condition(); index += 1) await Bun.sleep(5)
  expect(condition()).toBe(true)
}

const BAR: MenuOptions[] = [
  {
    title: 'App',
    items: [
      { kind: 'item', id: 'app.about', label: 'About' },
      { kind: 'separator' },
      { kind: 'item', id: 'app.quit', label: 'Quit', shortcut: { key: 'q', platform: true } },
    ],
  },
  {
    title: 'View',
    items: [
      {
        kind: 'submenu',
        label: 'Zoom',
        items: [
          {
            kind: 'item',
            id: 'view.zoom-in',
            label: 'Zoom In',
            shortcut: { key: '=', platform: true, shift: true },
            checked: true,
          },
          { kind: 'item', id: 'view.reset', label: 'Actual Size', enabled: false },
        ],
      },
    ],
  },
]

const ignore = () => {}

describe('application menu bar (headless real subprocess)', () => {
  test('reports the AppKit backend and the immutable, default-denied launch grant', async () => {
    for (const [permissions, permission] of [
      [ALLOW, 'allow'],
      [{}, 'deny'],
    ] as const)
      await withMenu(
        async (app) => {
          expect(app.serviceCapabilities.appMenu).toEqual({
            availability: 'available',
            permission,
            scope: 'application',
            backend: 'appkit',
          })
          expect(Object.isFrozen(app.serviceCapabilities.appMenu)).toBe(true)
        },
        'hold',
        permissions
      )
    await withMenu(async (app) => {
      expect(app.serviceCapabilities.appMenu).toEqual({
        availability: 'unavailable',
        reason: 'unsupported_platform',
      })
    }, 'unavailable')
  })

  test('sends the closed wire shape with explicit defaults', async () => {
    await withMenu(async (app, directory) => {
      const bar = await app.setMenuBar(BAR, ignore)
      expect(bar.active).toBe(true)
      expect(Object.isFrozen(bar)).toBe(true)
      const [sent] = requests(directory)
      expect(sent).toEqual({
        id: expect.any(Number),
        type: 'set_app_menu',
        menu_id: 1,
        menus: [
          {
            title: 'App',
            items: [
              { kind: 'item', id: 'app.about', label: 'About', enabled: true, checked: false },
              { kind: 'separator' },
              {
                kind: 'item',
                id: 'app.quit',
                label: 'Quit',
                shortcut: {
                  key: 'q',
                  modifiers: { control: false, alt: false, shift: false, platform: true },
                },
                enabled: true,
                checked: false,
              },
            ],
          },
          {
            title: 'View',
            items: [
              {
                kind: 'submenu',
                label: 'Zoom',
                enabled: true,
                items: [
                  {
                    kind: 'item',
                    id: 'view.zoom-in',
                    label: 'Zoom In',
                    shortcut: {
                      key: '=',
                      modifiers: { control: false, alt: false, shift: true, platform: true },
                    },
                    enabled: true,
                    checked: true,
                  },
                  {
                    kind: 'item',
                    id: 'view.reset',
                    label: 'Actual Size',
                    enabled: false,
                    checked: false,
                  },
                ],
              },
            ],
          },
        ],
      })
    })
  })

  test('rejects invalid menu bars locally with no native request', async () => {
    await withMenu(async (app, directory) => {
      const item = (id: string, extra: object = {}) => ({ kind: 'item', id, label: id, ...extra })
      const nest = (depth: number): MenuEntryOptions =>
        depth === 0
          ? { kind: 'item', id: 'leaf', label: 'Leaf' }
          : { kind: 'submenu', label: 'S', items: [nest(depth - 1)] }
      const cyclic: Record<string, unknown> = { kind: 'submenu', label: 'Loop' }
      cyclic['items'] = [cyclic]
      const invalid: unknown[] = [
        undefined,
        {},
        [{ title: 'A' }],
        [{ title: '', items: [item('a')] }],
        [{ title: 'A', items: [] }],
        [{ title: 'A', items: [item('a')], extra: true }],
        [{ title: 'A', items: [{ kind: 'action', id: 'a', label: 'A' }] }],
        [{ title: 'A', items: [item('a', { action: 'zed::Quit' })] }],
        [{ title: 'A', items: [item('has space')] }],
        [{ title: 'A', items: [item('x'.repeat(65))] }],
        [{ title: 'A', items: [{ kind: 'item', id: 'a', label: 'é'.repeat(32) + 'x' }] }],
        [{ title: 'A', items: [{ kind: 'item', id: 'a', label: 'line\nbreak' }] }],
        [
          { title: 'A', items: [item('a')] },
          { title: 'B', items: [item('a')] },
        ],
        [
          {
            title: 'A',
            items: [
              item('a', { shortcut: { key: 'o', platform: true } }),
              item('b', { shortcut: { key: 'o', platform: true } }),
            ],
          },
        ],
        [{ title: 'A', items: [item('a', { shortcut: { key: 'o' } })] }],
        [{ title: 'A', items: [item('a', { shortcut: { key: 'escape', shift: true } })] }],
        [{ title: 'A', items: [item('a', { shortcut: { key: 'O', platform: true } })] }],
        [{ title: 'A', items: [item('a', { shortcut: { key: 'f13', platform: true } })] }],
        [{ title: 'A', items: [item('a', { shortcut: { key: 'a', meta: true } })] }],
        [{ title: 'A', items: [item('a', { enabled: 1 })] }],
        [{ title: 'A', items: [{ kind: 'separator', label: '-' }] }],
        [{ title: 'A', items: [nest(3)] }],
        [{ title: 'A', items: [cyclic] }],
        Array.from({ length: 17 }, (_, index) => ({ title: 'M', items: [item('m' + index)] })),
        [{ title: 'A', items: Array.from({ length: 129 }, () => ({ kind: 'separator' })) }],
      ]
      for (const menus of invalid)
        await expect(app.setMenuBar(menus as MenuOptions[], ignore)).rejects.toBeInstanceOf(
          TypeError
        )
      await expect(app.setMenuBar(BAR, 'listener' as never)).rejects.toBeInstanceOf(TypeError)
      expect(requests(directory)).toEqual([])
      // The bounds themselves are accepted.
      await app.setMenuBar([{ title: 'A', items: [nest(2)] }], ignore)
      await app.setMenuBar(
        [
          {
            title: 'A',
            items: [
              { kind: 'item', id: 'help', label: 'Help', shortcut: { key: 'f1' } },
              ...Array.from({ length: 127 }, () => ({ kind: 'separator' }) as const),
            ],
          },
        ],
        ignore
      )
      expect(requests(directory)).toHaveLength(2)
    })
  })

  test('an unavailable backend or a denied grant rejects locally', async () => {
    await withMenu(async (app, directory) => {
      for (const call of [() => app.setMenuBar(BAR, ignore), () => app.clearMenuBar()]) {
        const error = await call().catch((cause: unknown) => cause)
        assert(error instanceof NativeServiceError)
        expect([error.service, error.code]).toEqual(['app_menu', 'service_unavailable'])
      }
      expect(requests(directory)).toEqual([])
    }, 'unavailable')
    await withMenu(
      async (app, directory) => {
        const error = await app.setMenuBar(BAR, ignore).catch((cause: unknown) => cause)
        assert(error instanceof NativeServiceError)
        expect([error.service, error.code]).toEqual(['app_menu', 'permission_denied'])
        expect(requests(directory)).toEqual([])
      },
      'hold',
      {}
    )
  })

  test('delivers a selection of the current bar with its handle and signal', async () => {
    await withMenu(async (app) => {
      const events: AppMenuItemEvent[] = []
      const bar = await app.setMenuBar(BAR, (event) => {
        events.push(event)
      })
      await until(() => events.length === 1)
      const [event] = events
      assert(event)
      expect(event.type).toBe('app_menu_item')
      expect(event.itemId).toBe('app.about')
      expect(event.menuBar).toBe(bar)
      expect(event.signal.aborted).toBe(false)
      expect(Object.isFrozen(event)).toBe(true)
      // Windows do not own the bar: closing one leaves it live.
      const window = await app.openWindow({ title: 'Menu owner' })
      await window.close()
      expect(bar.active).toBe(true)
      await app.shutdown()
      expect(bar.active).toBe(false)
      expect(event.signal.aborted).toBe(true)
      await expect(app.setMenuBar(BAR, ignore)).rejects.toBeInstanceOf(NativeStateError)
    }, 'select')
  })

  test('a new bar revokes the previous one and its stale selections', async () => {
    await withMenu(async (app, directory) => {
      const first: AppMenuItemEvent[] = []
      const second: AppMenuItemEvent[] = []
      const old = await app.setMenuBar(BAR, (event) => {
        first.push(event)
      })
      const current = await app.setMenuBar(
        [{ title: 'Edit', items: [{ kind: 'item', id: 'edit.undo', label: 'Undo' }] }],
        (event) => {
          second.push(event)
        }
      )
      expect(old.active).toBe(false)
      expect(current.active).toBe(true)
      await until(() => second.length === 1)
      await Bun.sleep(20)
      expect(first).toEqual([])
      expect(second.map((event) => event.itemId)).toEqual(['edit.undo'])
      // A replaced handle never clears its successor.
      await old.clear()
      expect(current.active).toBe(true)
      expect(requests(directory).map((request) => request['menu_id'])).toEqual([1, 2])
      // Clearing is idempotent and sends one empty bar under a new identity.
      await Promise.all([current.clear(), current.clear()])
      expect(current.active).toBe(false)
      expect(second[0]?.signal.aborted).toBe(true)
      const sent = requests(directory)
      expect(sent.map((request) => [request['menu_id'], request['menus']])).toEqual([
        [1, expect.any(Array)],
        [2, expect.any(Array)],
        [3, []],
      ])
      await app.clearMenuBar()
      expect(requests(directory).at(-1)).toMatchObject({ menu_id: 4, menus: [] })
    }, 'stale')
  })

  test('a native failure revokes the submitted bar', async () => {
    await withMenu(async (app) => {
      const error = await app.setMenuBar(BAR, ignore).catch((cause: unknown) => cause)
      assert(error instanceof NativeServiceError)
      expect([error.service, error.code]).toEqual(['app_menu', 'native_failure'])
    }, 'fail')
  })

  test('a selection without the capability or for an unallocated bar is a host fault', async () => {
    for (const mode of ['forged', 'unallocated']) {
      const directory = mkdtempSync(join(tmpdir(), 'bun-native-app-menu-peer-'))
      try {
        const app = await createApplication({
          executable: process.execPath,
          args: [resolve(import.meta.dir, 'app-menu-peer.ts'), directory, mode],
          permissions: ALLOW,
          requestTimeoutMs: 2_000,
        })
        if (mode === 'unallocated') await app.setMenuBar(BAR, ignore).catch(() => {})
        await expect(app.closed).rejects.toBeInstanceOf(ProtocolError)
        await app.shutdown().catch(() => {})
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })
})
