import { expect } from 'bun:test'
import {
  createApplication,
  type NativeApplication,
  type ServicePermissions,
} from '@bun-native/core'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Runs `run` against a public core application whose host is one headless service
 * peer script in this directory, then requires a fully drained shutdown. A peer
 * that blocks until released (clipboard) is unblocked before shutdown.
 */
export async function withServicePeer(
  peer: 'clipboard-peer' | 'file-peer' | 'notification-peer' | 'shortcut-peer',
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode: string,
  permissions: ServicePermissions,
  { release = false } = {}
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `bun-native-${peer}-`))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, `${peer}.ts`), directory, mode],
      permissions,
      requestTimeoutMs: 2_000,
    })
    await run(app, directory)
  } finally {
    if (release) writeFileSync(join(directory, 'release'), '')
    await app?.shutdown().catch(() => {})
    await app?.closed.catch(() => {})
    if (app) expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Commands of one type that the peer recorded, in arrival order. */
export function peerRequests(directory: string, type: string): Record<string, unknown>[] {
  const path = join(directory, 'requests.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((value) => value['type'] === type)
}

/** Let the transport deliver and the serialized callback queue drain. */
export async function settle(app: NativeApplication): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Bun.sleep(5)
    if (!app.diagnostics.queuedCallbacks && !app.diagnostics.activeCallbacks) return
  }
}
