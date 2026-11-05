/**
 * Real owned-process qualification against the native host: on Linux on an
 * isolated X11 display, on macOS in the runner's window session. Every child
 * is a real program; outputs, exit statuses, the working directory and
 * process-group teardown are checked independently (through /proc and node:fs
 * on Linux, through ps on macOS). Raw protocol checks drive the same host
 * through the private runtime to prove foreign, stale and reused process
 * handles are rejected natively. macOS has no filesystem grants, so there a
 * working directory must be refused instead of resolved.
 */
import {
  createApplication,
  NativeServiceError,
  type NativeApplication,
  type NativeWindow,
  type ProcessEvent,
} from '@bun-native/core'
import { NativeCommandError, NativeHost } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { release, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_PROCESS_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_PROCESS_MODE']
const macos = process.platform === 'darwin'
if (process.platform !== 'linux' && !macos)
  throw new Error('Owned processes are qualified on Linux and macOS only')
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  (!macos && (!process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']))
)
  throw new Error('An isolated X11 display, evidence directory, host and mode are required')
const host = executable

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}
const rejected = (code: string) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === 'processes' && error.code === code

const PATH = { PATH: '/usr/bin:/bin' }
const base = mkdtempSync(join(tmpdir(), 'bun-native-processes-'))
const work = join(base, 'work')
mkdirSync(join(work, 'sub'), { recursive: true })
symlinkSync(base, join(work, 'up'))
const permissions = {
  processes: [
    { id: 'shell', executable: '/bin/sh' },
    { id: 'missing', executable: join(base, 'missing') },
  ],
  // macOS has no filesystem grants to name a working directory with.
  filesystemRoots: macos ? [] : [{ id: 'work', path: work, access: 'read' as const }],
}

/** One process: its decoded output by stream and its exit, all acknowledged. */
function watch() {
  const streams: Record<string, string> = {}
  let exit: ProcessEvent | undefined
  let changed = () => {}
  const decoder = new TextDecoder()
  return {
    streams,
    listener: (event: ProcessEvent) => {
      if (event.type === 'process_output')
        streams[event.stream] = (streams[event.stream] ?? '') + decoder.decode(event.bytes)
      else exit = event
      changed()
    },
    /** Resolves once `done` holds; every delivery wakes it. */
    until(done: () => boolean, limitMs = 5_000) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Process evidence did not arrive')),
          limitMs
        )
        const check = () => {
          if (!done()) return
          clearTimeout(timer)
          changed = () => {}
          resolve()
        }
        changed = check
        check()
      })
    },
    get exit() {
      return exit?.type === 'process_exited' ? exit.exit : undefined
    },
  }
}

/** Each live process's group and state, from ps (macOS has no /proc). */
function psRows() {
  const listed = Bun.spawnSync(['/bin/ps', '-A', '-o', 'pid=,pgid=,stat='])
  if (!listed.success) throw new Error('ps could not list processes')
  return new TextDecoder()
    .decode(listed.stdout)
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 3)
    .map(([pid, group, state]) => ({ pid: Number(pid), group: Number(group), state: state! }))
}

/** The process group of a running process. */
function groupOf(pid: number) {
  if (macos) return psRows().find((row) => row.pid === pid)?.group
  return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[2])
}

/** True once no member of the group still runs: gone, or a zombie for init to reap. */
function groupStopped(group: number) {
  if (macos) return psRows().every((row) => row.group !== group || row.state.startsWith('Z'))
  for (const entry of new Bun.Glob('[0-9]*').scanSync({ cwd: '/proc', onlyFiles: false })) {
    let stat: string
    try {
      stat = readFileSync(join('/proc', entry, 'stat'), 'utf8')
    } catch {
      continue
    }
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    if (Number(fields[2]) === group && fields[0] !== 'Z') return false
  }
  return true
}

async function stopped(group: number) {
  for (let turn = 0; turn < 400; turn += 1) {
    if (groupStopped(group)) return true
    await Bun.sleep(5)
  }
  return false
}

async function withApp<T>(run: (app: NativeApplication, window: NativeWindow) => Promise<T>) {
  const app = await createApplication({ executable: host, permissions })
  try {
    return await run(app, await app.openWindow({ title: 'Processes' }))
  } finally {
    await app.shutdown()
    await app.closed
  }
}

async function deniedByDefault() {
  const app = await createApplication({ executable: host })
  try {
    assert.deepEqual(app.serviceCapabilities.ptyProcess, {
      availability: 'available',
      executables: {},
      scope: 'owned_window',
      backend: 'posix',
    })
    const window = await app.openWindow({ title: 'Process denial' })
    await assert.rejects(
      window.spawnProcess('shell', {}, () => {}),
      rejected('permission_denied')
    )
    record('nativeDefaultDenial', { code: 'permission_denied' })
  } finally {
    await app.shutdown()
    await app.closed
  }
}

/** macOS: pipes and the explicit environment; a working directory is refused. */
async function pipesWithoutGrants(app: NativeApplication, window: NativeWindow) {
  const seen = watch()
  const child = await window.spawnProcess(
    'shell',
    {
      args: ['-c', 'printf out; printf err >&2; printf "|%s|%s|" "$HOME" "$BUN_X"; exit 5'],
      env: { BUN_X: 'a b' },
    },
    seen.listener
  )
  await seen.until(() => seen.exit !== undefined)
  assert.equal(child.terminal, false)
  assert.deepEqual(seen.exit, { code: 5 })
  assert.equal(seen.streams['stdout'], 'out||a b|')
  assert.equal(seen.streams['stderr'], 'err')
  assert.equal(app.serviceCapabilities.filesystemGrants.availability, 'unavailable')
  record('pipesAndEnvironment', { exit: seen.exit, inheritedHome: false })
  await assert.rejects(
    window.spawnProcess('missing', {}, () => {}),
    rejected('not_found')
  )
  record('executableFailureIsTyped', { missing: 'not_found' })
  await child.release()
}

async function pipes(window: NativeWindow) {
  const grant = await window.openFileGrant('work')
  const seen = watch()
  const child = await window.spawnProcess(
    'shell',
    {
      args: ['-c', 'printf out; printf err >&2; printf "|%s|%s|" "$HOME" "$BUN_X"; pwd -P; exit 5'],
      env: { BUN_X: 'a b' },
      cwd: { grant, path: 'sub' },
    },
    seen.listener
  )
  await seen.until(() => seen.exit !== undefined)
  assert.equal(child.terminal, false)
  assert.deepEqual(seen.exit, { code: 5 })
  assert.equal(seen.streams['stdout'], 'out||a b|' + realpathSync(join(work, 'sub')) + '\n')
  assert.equal(seen.streams['stderr'], 'err')
  record('pipesEnvironmentAndGrantDirectory', {
    exit: seen.exit,
    cwd: realpathSync(join(work, 'sub')),
    inheritedHome: false,
  })
  for (const [path, code] of [
    ['up', 'path_denied'],
    ['nothing', 'not_found'],
  ] as const)
    await assert.rejects(
      window.spawnProcess('shell', { cwd: { grant, path } }, () => {}),
      rejected(code)
    )
  await assert.rejects(
    window.spawnProcess('missing', {}, () => {}),
    rejected('not_found')
  )
  record('directoryAndExecutableFailuresAreTyped', { link: 'path_denied', missing: 'not_found' })
  await child.release()
  await grant.close()
}

async function terminal(window: NativeWindow) {
  const seen = watch()
  const child = await window.spawnProcess(
    'shell',
    {
      args: ['-c', 'stty size; test -t 0 && echo tty; read line; stty size; echo "got:$line"'],
      env: PATH,
      terminal: { columns: 90, rows: 12 },
    },
    seen.listener
  )
  await seen.until(() => (seen.streams['terminal'] ?? '').includes('tty'))
  await child.resize({ columns: 100, rows: 30 })
  await child.write(new TextEncoder().encode('hello\n'))
  await seen.until(() => seen.exit !== undefined)
  const lines = (seen.streams['terminal'] ?? '').split(/\r?\n/).map((line) => line.trim())
  assert.deepEqual(lines.slice(0, 2), ['12 90', 'tty'])
  // The terminal echoes the typed line before the shell reads it.
  assert.deepEqual(lines.slice(2, 5), ['hello', '30 100', 'got:hello'])
  assert.deepEqual(seen.exit, { code: 0 })
  assert.deepEqual(Object.keys(seen.streams), ['terminal'])
  record('terminalSizeResizeAndInput', { lines: lines.slice(0, 5) })
  await child.release()
}

async function signals(window: NativeWindow) {
  const seen = watch()
  const child = await window.spawnProcess(
    'shell',
    {
      args: ['-c', 'trap "exit 9" INT; sleep 30 & echo "$$ $!"; wait; wait'],
      env: PATH,
    },
    seen.listener
  )
  await seen.until(() => (seen.streams['stdout'] ?? '').endsWith('\n'))
  const [group, background] = (seen.streams['stdout'] ?? '').trim().split(' ').map(Number)
  assert.equal(groupOf(background!), group)
  await child.signal('interrupt')
  await seen.until(() => seen.exit !== undefined)
  assert.deepEqual(seen.exit, { code: 9 })
  assert.equal(await stopped(group!), true)
  await assert.rejects(child.signal('kill'), rejected('invalid_state'))
  record('groupSignalAndExitStopsDescendants', { exit: seen.exit, descendantStopped: true })
  await child.release()
}

async function credit(window: NativeWindow) {
  let bytes = 0
  let chunks = 0
  let largest = 0
  const seen = watch()
  await window.spawnProcess(
    'shell',
    { args: ['-c', 'head -c 300000 /dev/zero'], env: PATH },
    async (event) => {
      if (event.type === 'process_output') {
        bytes += event.bytes.byteLength
        chunks += 1
        largest = Math.max(largest, event.bytes.byteLength)
        // A slow consumer: the host holds the child at its delivery credit.
        await Bun.sleep(2)
      }
      seen.listener(event)
    }
  )
  await seen.until(() => seen.exit !== undefined, 10_000)
  assert.equal(bytes, 300_000)
  assert.equal(largest <= 16_384, true)
  record('creditedOutputIsComplete', { bytes, chunks, largest })
}

async function revocation() {
  const group = async (window: NativeWindow, script = 'echo $$; exec sleep 30') => {
    const seen = watch()
    const child = await window.spawnProcess(
      'shell',
      { args: ['-c', script], env: PATH },
      seen.listener
    )
    await seen.until(() => (seen.streams['stdout'] ?? '').endsWith('\n'))
    return { child, id: Number(seen.streams['stdout']!.trim()) }
  }
  const results = await withApp(async (app, window) => {
    const released = await group(window)
    await released.child.release()
    const releaseStopped = await stopped(released.id)
    const closing = await app.openWindow({ title: 'Owner' })
    const owned = await group(closing)
    await closing.close()
    const closeStopped = await stopped(owned.id)
    assert.equal(owned.child.active, false)
    const survivor = await group(window)
    return { releaseStopped, closeStopped, survivor }
  })
  const shutdownStopped = await stopped(results.survivor.id)
  assert.deepEqual(
    [results.releaseStopped, results.closeStopped, shutdownStopped, results.survivor.child.active],
    [true, true, true, false]
  )
  record('releaseCloseAndShutdownStopGroups', {
    release: results.releaseStopped,
    windowClose: results.closeStopped,
    shutdown: shutdownStopped,
  })
}

async function rawHandles() {
  const native = await NativeHost.launch({
    executable: host,
    permissions,
    requestTimeoutMs: 5_000,
  })
  const code = (operation: Promise<unknown>) =>
    operation.then(
      () => 'accepted',
      (error: unknown) => (error instanceof NativeCommandError ? error.code : String(error))
    )
  try {
    for (const window_id of [1, 2])
      await native.send({
        type: 'open',
        window_id,
        root_id: window_id,
        title: 'Raw ' + window_id,
        width: 200,
        height: 120,
      })
    const spawn = (window_id: number, process_id: number, executable = 'shell') =>
      native.send({
        type: 'spawn_process',
        window_id,
        process_id,
        launch: { executable, args: ['-c', 'exec sleep 30'], env: PATH },
      })
    await spawn(1, 5)
    const write = (window_id: number, process_id: number) =>
      native.send({ type: 'write_process', window_id, process_id, data: 'eA==' })
    const results = {
      foreignWindow: await code(write(2, 5)),
      unknownProcess: await code(write(1, 6)),
      reusedId: await code(spawn(2, 5)),
      lowerId: await code(spawn(2, 4)),
      ungranted: await code(spawn(1, 7, 'python')),
      // No grant 9 was opened (the macOS run opens none): a cwd never becomes a path.
      unopenedCwd: await code(
        native.send({
          type: 'spawn_process',
          window_id: 1,
          process_id: 8,
          launch: {
            executable: 'shell',
            args: ['-c', 'true'],
            env: PATH,
            cwd: { grant_id: 9, path: '' },
          },
        })
      ),
      pipeResize: await code(
        native.send({
          type: 'resize_process',
          window_id: 1,
          process_id: 5,
          size: { columns: 10, rows: 10 },
        })
      ),
      undeliveredAck: await code(
        native.send({ type: 'acknowledge_process_output', window_id: 1, process_id: 5, chunk: 1 })
      ),
    }
    await native.send({ type: 'release_process', window_id: 1, process_id: 5 })
    Object.assign(results, {
      staleWrite: await code(write(1, 5)),
      staleRelease: await code(
        native.send({ type: 'release_process', window_id: 1, process_id: 5 })
      ),
    })
    assert.deepEqual(results, {
      foreignWindow: 'invalid_handle',
      unknownProcess: 'invalid_handle',
      reusedId: 'invalid_handle',
      lowerId: 'invalid_handle',
      ungranted: 'permission_denied',
      unopenedCwd: 'invalid_handle',
      pipeResize: 'wrong_kind',
      undeliveredAck: 'invalid_state',
      staleWrite: 'invalid_handle',
      staleRelease: 'invalid_handle',
    })
    record('nativeHandleChecks', results)
  } finally {
    await native.shutdown()
  }
}

try {
  await deniedByDefault()
  await withApp(async (app, window) => {
    await (macos ? pipesWithoutGrants(app, window) : pipes(window))
    await terminal(window)
    await signals(window)
    await credit(window)
  })
  await revocation()
  await rawHandles()
  assert.equal(existsSync(join(work, 'sub')), true)
} finally {
  rmSync(base, { recursive: true, force: true })
}

writeFileSync(
  join(output, 'processes.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      platform: process.platform,
      kernel: macos ? release() : readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(),
      display: macos ? 'macOS runner window session' : 'isolated Xvfb with openbox',
      children: macos
        ? 'real /bin/sh programs; groups checked through ps; no working directory (no filesystem grants)'
        : 'real /bin/sh programs; groups checked through /proc',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Owned process qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
