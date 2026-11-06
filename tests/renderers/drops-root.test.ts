import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApplication, NativeStateError, type NativeApplication } from '@bun-native/core'
import {
  createElement,
  createRenderRoot,
  insertNode,
  registerDropTarget,
  removeNode,
  type Node,
} from '@bun-native/renderer'
import * as react from '@bun-native/react'
import * as solid from '@bun-native/solid'

// Headless drop peer: real IPC through the public core, no drag is simulated.
async function withDrops(run: (app: NativeApplication, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-drops-root-'))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, '../core/drop-peer.ts'), directory, 'normal'],
      permissions: { dragDrop: 'allow' },
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

function registrations(directory: string) {
  const path = join(directory, 'requests.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((value) => value['type'] === 'register_drop_target')
}

const invalidHandle = (error: unknown) =>
  error instanceof NativeStateError && error.code === 'invalid_handle'

test('Solid and React re-export the renderer registerDropTarget', () => {
  expect(solid.registerDropTarget).toBe(registerDropTarget)
  expect(react.registerDropTarget).toBe(registerDropTarget)
})

test('a render root registers only committed elements and revokes on unmount', () =>
  withDrops(async (app, directory) => {
    const window = await app.openWindow({ title: 'Renderer drops' })
    const zone = createElement('box')
    const sibling = createElement('box')
    let parent: Node | undefined
    const root = createRenderRoot(window, ({ container }) => {
      parent = container
      insertNode(container, zone)
      insertNode(container, sibling)
    })
    await root.ready
    const target = await registerDropTarget(zone, () => {})
    expect(target.active).toBe(true)
    expect(registrations(directory)).toHaveLength(1)

    // Inserted but not yet committed: rejected without a native request.
    const pending = createElement('box')
    insertNode(zone, pending)
    await assert.rejects(
      registerDropTarget(pending, () => {}),
      invalidHandle
    )
    expect(registrations(directory)).toHaveLength(1)
    await root.flush()
    const nested = await registerDropTarget(pending, () => {})

    // Removing the ancestor element revokes both targets at the commit.
    removeNode(parent!, zone)
    await root.flush()
    expect(target.active).toBe(false)
    expect(nested.active).toBe(false)
    await assert.rejects(
      registerDropTarget(zone, () => {}),
      invalidHandle
    )

    // Disposal removes the root's subtree, so a mounted sibling's target ends too.
    const kept = await registerDropTarget(sibling, () => {})
    await root.dispose()
    expect(kept.active).toBe(false)
    await assert.rejects(
      registerDropTarget(sibling, () => {}),
      invalidHandle
    )
    expect(registrations(directory)).toHaveLength(3)
  }))
