import { describe, expect, test } from 'bun:test'
import { createApplication, NativeStateError, type NativeApplication } from '@bun-native/core'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const items = [
  { kind: 'item', id: 'copy', label: 'Copy', shortcut: { key: 'c', platform: true } },
  { kind: 'separator' },
  { kind: 'submenu', label: 'Share', items: [{ kind: 'item', id: 'mail', label: 'Mail' }] },
  { kind: 'item', id: 'wrap', label: 'Wrap', checked: true, enabled: false },
] as const
const at = { x: 12, y: 34 }

async function withPeer(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'hold'
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-context-menu-peer-'))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, 'context-menu-peer.ts'), directory, mode],
      requestTimeoutMs: 2_000,
    })
    await run(app, directory)
  } finally {
    await app?.shutdown().catch(() => {})
    await app?.closed.catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
}

function requests(directory: string, type: string) {
  const path = join(directory, 'requests.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((value) => value['type'] === type)
}

async function until(condition: () => boolean) {
  for (let index = 0; index < 100 && !condition(); index += 1) await Bun.sleep(5)
  expect(condition()).toBe(true)
}

describe('OS context menus (headless real subprocess)', () => {
  test('the capability names the platform backend', async () => {
    await withPeer(async (app) => {
      expect(app.serviceCapabilities.contextMenus).toMatchObject({
        availability: 'available',
        scope: 'owned_window',
      })
    })
    await withPeer(async (app) => {
      expect(app.serviceCapabilities.contextMenus).toMatchObject({ availability: 'unavailable' })
      const window = await app.openWindow({ title: 'Unsupported' })
      await assert.rejects(window.showContextMenu(items, at), { name: 'UnsupportedFeatureError' })
    }, 'unsupported')
  })

  test('a shown menu sends the wire items and resolves a nested choice', async () => {
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Menu' })
      expect(await window.showContextMenu(items, at)).toBe('mail')
      const [sent] = requests(directory, 'show_context_menu')
      expect(sent).toMatchObject({ x: 12, y: 34 })
      expect(sent?.['items']).toHaveLength(4)
      expect(requests(directory, 'close_context_menu')).toEqual([])
    }, 'choose-nested')
  })

  test('a dismissed menu resolves null', async () => {
    await withPeer(async (app) => {
      const window = await app.openWindow({ title: 'Dismiss' })
      expect(await window.showContextMenu(items, at)).toBeNull()
    }, 'dismiss')
  })

  test('invalid items and positions are rejected before anything is sent', async () => {
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Invalid' })
      await assert.rejects(window.showContextMenu([], at), TypeError)
      await assert.rejects(window.showContextMenu(items, { x: -1, y: 0 }), TypeError)
      await assert.rejects(window.showContextMenu(items, { x: Number.NaN, y: 0 }), TypeError)
      expect(requests(directory, 'show_context_menu')).toEqual([])
    })
  })

  test('host unavailability and a second live menu map to service errors', async () => {
    await withPeer(async (app) => {
      const window = await app.openWindow({ title: 'Unavailable' })
      await assert.rejects(window.showContextMenu(items, at), {
        name: 'NativeServiceError',
        service: 'context_menus',
        code: 'service_unavailable',
      })
    }, 'unavailable')
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Limit' })
      const first = window.showContextMenu(items, at)
      void first.catch(() => {})
      await until(() => requests(directory, 'show_context_menu').length === 1)
      await Bun.sleep(10)
      await assert.rejects(window.showContextMenu(items, at), {
        name: 'NativeServiceError',
        code: 'limit_exceeded',
      })
    })
  })

  test('abort closes the OS menu and drops a late choice', async () => {
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Abort' })
      const controller = new AbortController()
      const pending = window.showContextMenu(items, at, { signal: controller.signal })
      await until(() => requests(directory, 'show_context_menu').length === 1)
      await Bun.sleep(10)
      controller.abort()
      await assert.rejects(pending, { name: 'NativeServiceError', code: 'cancelled' })
      await until(() => requests(directory, 'close_context_menu').length === 1)
      // The next menu opens and is not resolved by the late choice.
      const next = new AbortController()
      const second = window.showContextMenu(items, at, { signal: next.signal })
      await until(() => requests(directory, 'show_context_menu').length === 2)
      await Bun.sleep(10)
      next.abort()
      await assert.rejects(second, { code: 'cancelled' })
    }, 'late')
  })

  test('owner close rejects a live menu without a close command', async () => {
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Owner' })
      const pending = window.showContextMenu(items, at)
      await until(() => requests(directory, 'show_context_menu').length === 1)
      await Bun.sleep(10)
      const revoked = assert.rejects(
        pending,
        (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
      )
      await window.close()
      await revoked
      expect(requests(directory, 'close_context_menu')).toEqual([])
    })
  })

  test('a choice the menu was not given fails the channel', async () => {
    await withPeer(async (app) => {
      const window = await app.openWindow({ title: 'Foreign' })
      void window.showContextMenu(items, at).catch(() => {})
      await assert.rejects(app.closed, /not given/)
    }, 'foreign-item')
  })

  test('a completion for an unallocated menu fails the channel', async () => {
    await withPeer(async (app) => {
      const window = await app.openWindow({ title: 'Unallocated' })
      void window.showContextMenu(items, at).catch(() => {})
      await assert.rejects(app.closed, /unallocated context menu/)
    }, 'unallocated')
  })
})
