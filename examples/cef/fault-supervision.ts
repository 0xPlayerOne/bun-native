import assert from 'node:assert/strict'
import { constants, watch } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstat, open, writeFile } from 'node:fs/promises'

const mode = 'backend-shell-tree-exit'
/** Private contributor receipts, not a process-authority API. */
export function validateTreeObservation(
  value: unknown,
  nonce: string,
  pids: readonly number[]
): void {
  assert.match(nonce, /^[a-f0-9]{48}$/)
  assert.equal(pids.length, 2)
  assert.equal(new Set(pids).size, 2)
  assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid < 2 ** 31))
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const row = value as Record<string, unknown>
  assert.deepEqual(Object.keys(row).sort(), ['mode', 'nonce', 'pids'])
  assert.equal(row['mode'], mode)
  assert.equal(row['nonce'], nonce)
  assert.deepEqual(row['pids'], pids)
}

/** One filesystem notification subscription and one deadline, no polling loop. */
export function waitForTreeObservation(
  path: string,
  nonce: string,
  pids: readonly number[],
  timeoutMs: number
): Promise<void> {
  assert.ok(
    isAbsolute(path) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000
  )
  validateTreeObservation({ mode, nonce, pids }, nonce, pids)
  const expected = [...pids]
  return new Promise((resolve, reject) => {
    let ended = false,
      checking = false,
      dirty = false
    const deadline = performance.now() + timeoutMs
    const timer = setTimeout(
      () => finish(new Error('Owned descendants were not observed before deadline')),
      timeoutMs
    )
    let watcher: ReturnType<typeof watch> | undefined
    function finish(error?: unknown) {
      if (ended) return
      ended = true
      clearTimeout(timer)
      watcher?.close()
      if (error) reject(error)
      else resolve()
    }
    async function check() {
      if (ended) return
      if (checking) {
        dirty = true
        return
      }
      checking = true
      try {
        do {
          dirty = false
          const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          })
          if (!stat) continue
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024)
            throw new Error('Unsafe tree observation file')
          const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          try {
            const info = await file.stat()
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              info.dev !== stat.dev ||
              info.ino !== stat.ino
            )
              throw new Error('Changed tree observation file')
            const bytes = Buffer.alloc(1025)
            const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
            if (bytesRead > 1024) throw new Error('Tree observation exceeds bound')
            validateTreeObservation(
              JSON.parse(bytes.subarray(0, bytesRead).toString()),
              nonce,
              expected
            )
            if (performance.now() >= deadline) throw new Error('Late tree observation')
            finish()
          } finally {
            await file.close()
          }
        } while (dirty && !ended)
      } catch (error) {
        finish(error)
      } finally {
        checking = false
      }
    }
    try {
      watcher = watch(dirname(path), () => {
        void check()
      })
      watcher.on('error', finish)
      void check()
    } catch (error) {
      finish(error)
    }
  })
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
    await writeFile(tree, JSON.stringify({ mode, nonce, backend: process.pid, pids }), {
      flag: 'wx',
      mode: 0o600,
    })
    await waitForTreeObservation(observed, nonce, pids, timeoutMs)
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
