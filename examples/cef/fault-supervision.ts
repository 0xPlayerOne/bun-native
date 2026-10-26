import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstat, open, writeFile } from 'node:fs/promises'

import {
  treeObservationGate,
  validateTreeObservation,
  type TreeFaultMode,
} from './fault-tree-notification.ts'
export { validateTreeObservation } from './fault-tree-notification.ts'

const mode = 'backend-shell-tree-exit'

/** Read the same exact private receipt only after an explicit retained notification.
 * File visibility alone and an OS watcher registration are not readiness signals.
 */
export async function waitForTreeObservation(
  path: string,
  nonce: string,
  pids: readonly number[],
  timeoutMs: number,
  notification: (signal: AbortSignal) => Promise<void>,
  observedMode: TreeFaultMode = mode
): Promise<void> {
  assert.ok(
    isAbsolute(path) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000
  )
  validateTreeObservation({ mode: observedMode, nonce, pids }, nonce, pids, observedMode)
  const expected = [...pids]
  const deadline = performance.now() + timeoutMs
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => notification(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Owned descendants were not observed before deadline'))
        }, timeoutMs)
      }),
    ])
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024)
      throw new Error('Unsafe tree observation file')
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.dev !== stat.dev || info.ino !== stat.ino)
        throw new Error('Changed tree observation file')
      const bytes = Buffer.alloc(1025)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 1024) throw new Error('Tree observation exceeds bound')
      validateTreeObservation(
        JSON.parse(bytes.subarray(0, bytesRead).toString()),
        nonce,
        expected,
        observedMode
      )
      if (performance.now() >= deadline) throw new Error('Late tree observation')
    } finally {
      await file.close()
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Fixed contributor shell only; callers never supply shell command text. */
export function spawnFaultShell(entry: string, nonce: string) {
  assert.ok(isAbsolute(entry) && !/[\0\r\n]/.test(entry))
  const windows = process.platform === 'win32'
  const systemRoot = process.env['SystemRoot']
  if (windows) assert.ok(systemRoot && isAbsolute(systemRoot))
  const cmd = windows
    ? [
        join(systemRoot!, 'System32', 'cmd.exe'),
        '/d',
        '/s',
        '/v:off',
        '/c',
        '""%BUNLY_FAULT_RUNTIME%" "%BUNLY_FAULT_ENTRY%""',
      ]
    : [
        '/bin/sh',
        '-c',
        '"$1" "$2" & child=$!; wait "$child"',
        'bunly-owned-shell',
        process.execPath,
        entry,
      ]
  return Bun.spawn(cmd, {
    // cmd /s /c parses its own enclosing quotes; CRT escaping inserts literal
    // backslashes and breaks the Unicode/space-containing packaged path.
    windowsVerbatimArguments: windows,
    env: {
      BUNLY_CEF_FAULT_NONCE: nonce,
      BUNLY_FAULT_RUNTIME: process.execPath,
      BUNLY_FAULT_ENTRY: entry,
      ...(systemRoot ? { SystemRoot: systemRoot } : {}),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  })
}

/** The shell remains a child and the listening Bun server is its grandchild. */
export async function startObservedShellTree(timeoutMs: number): Promise<void> {
  const nonce = process.env['BUNLY_CEF_FAULT_NONCE'] ?? ''
  const tree = process.env['BUNLY_CEF_FAULT_TREE'] ?? ''
  const observed = process.env['BUNLY_CEF_FAULT_INJECTED'] ?? ''
  assert.ok(isAbsolute(tree) && isAbsolute(observed) && /^[a-f0-9]{48}$/.test(nonce))
  const entry = fileURLToPath(new URL('./fault-tree-child.js', import.meta.url))
  const shell = spawnFaultShell(entry, nonce)
  const reader = shell.stdout.getReader()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const ready = await Promise.race([
      (async () => {
        const storage = new Uint8Array(1024)
        let length = 0
        while (true) {
          const chunk = await reader.read()
          if (chunk.done || chunk.value.byteLength > storage.byteLength - length)
            throw new Error('Missing or oversized server readiness')
          storage.set(chunk.value, length)
          length += chunk.value.byteLength
          if (storage[length - 1] === 10) break
        }
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(storage.subarray(0, length))
        ) as Record<string, unknown>
      })(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Shell server readiness deadline')), timeoutMs)
      }),
    ])
    assert.deepEqual(Object.keys(ready).sort(), ['nonce', 'parentPid', 'pid', 'port'])
    assert.equal(ready['nonce'], nonce)
    assert.equal(ready['parentPid'], shell.pid)
    assert.ok(Number.isSafeInteger(ready['pid']) && Number(ready['pid']) > 0)
    assert.ok(
      Number.isSafeInteger(ready['port']) &&
        Number(ready['port']) > 0 &&
        Number(ready['port']) <= 65535
    )
    assert.equal(
      await (
        await fetch(`http://127.0.0.1:${ready['port']}/`, {
          signal: AbortSignal.timeout(timeoutMs),
        })
      ).text(),
      'owned-native-fault-server'
    )
    const pids = [shell.pid, Number(ready['pid'])]
    for (const [index, pid] of pids.entries())
      console.error(
        JSON.stringify({
          event: 'bunly.fault.descendant',
          pid,
          parentPid: index === 0 ? process.pid : shell.pid,
          role: index === 0 ? 'shell' : 'server',
        })
      )
    await writeFile(
      tree,
      JSON.stringify({ mode, nonce, backend: process.pid, pids, port: ready['port'] }),
      {
        flag: 'wx',
        mode: 0o600,
      }
    )
    await waitForTreeObservation(observed, nonce, pids, timeoutMs, async (signal) => {
      const response = await fetch(`http://127.0.0.1:${ready['port']}/observation`, {
        headers: { 'x-bunly-observation': nonce },
        signal,
        redirect: 'error',
      })
      assert.equal(response.status, 204, 'Missing independent tree notification')
    })
    console.error(
      JSON.stringify({ event: 'bunly.fault.tree-observed', mode, count: 2, serverResponded: true })
    )
    process.exit(23)
  } finally {
    clearTimeout(deadline)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    if (shell.exitCode === null) shell.kill('SIGKILL')
    // The native host still owns this fixture's entire non-detached group/job.
  }
}

/** Keep the original inherited-output direct child alive until the independent
 * observer has captured its exact ancestry, rather than guessing with a sleep. */
export async function startObservedDirectChild(timeoutMs: number): Promise<void> {
  const selected = 'backend-tree-exit'
  const nonce = process.env['BUNLY_CEF_FAULT_NONCE'] ?? ''
  const tree = process.env['BUNLY_CEF_FAULT_TREE'] ?? ''
  const observed = process.env['BUNLY_CEF_FAULT_INJECTED'] ?? ''
  assert.ok(isAbsolute(tree) && isAbsolute(observed) && /^[a-f0-9]{48}$/.test(nonce))
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const pids = [child.pid]
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 1024,
      fetch: treeObservationGate(nonce, pids, selected),
    })
    console.error(JSON.stringify({ event: 'bunly.fault.descendant', pid: child.pid }))
    await writeFile(
      tree,
      JSON.stringify({ mode: selected, nonce, backend: process.pid, pids, port: server.port }),
      { flag: 'wx', mode: 0o600 }
    )
    await waitForTreeObservation(
      observed,
      nonce,
      pids,
      timeoutMs,
      async (signal) => {
        const response = await fetch(new URL('/observation', server!.url), {
          headers: { 'x-bunly-observation': nonce },
          signal,
          redirect: 'error',
        })
        assert.equal(response.status, 204, 'Missing independent direct-child observation')
      },
      selected
    )
    process.exit(23)
  } finally {
    server?.stop(true)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
}
