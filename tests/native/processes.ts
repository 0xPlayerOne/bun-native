/**
 * Real owned-process qualification against the native host: on Linux on an
 * isolated X11 display, on macOS in the runner's window session. Every child
 * is a real program; outputs, exit statuses, the working directory and
 * process-group teardown are checked independently (through /proc and node:fs
 * on Linux, through ps on macOS, through CIM process listings on Windows).
 * Raw protocol checks drive the same host through the private runtime to
 * prove foreign, stale and reused process handles are rejected natively. This
 * macOS process fixture supplies no filesystem roots, and its process backend
 * refuses working directories. On Windows every child is cmd.exe in a job
 * object; the escape fixture is an NTFS junction made with mklink /J.
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
const windows = process.platform === 'win32'
if (process.platform !== 'linux' && !macos && !windows)
  throw new Error('Owned processes are qualified on Linux, macOS and Windows only')
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  (process.platform === 'linux' && (!process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']))
)
  throw new Error('An isolated X11 display, evidence directory, host and mode are required')
const host = executable

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(
    JSON.stringify({
      outcome: name,
      atMs: Math.round(performance.now() - started),
    })
  )
}
const rejected = (code: string) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === 'processes' && error.code === code

const systemRoot = windows ? process.env['SystemRoot'] : undefined
if (windows && (!systemRoot || !isAbsolute(systemRoot)))
  throw new Error('SystemRoot must name the Windows directory')
const cmd = join(systemRoot ?? '', 'System32', 'cmd.exe')
/** What a child needs to find programs; nothing else is inherited. */
const PATH = windows
  ? { SystemRoot: systemRoot!, PATH: join(systemRoot!, 'System32') }
  : { PATH: '/usr/bin:/bin' }
/** The arguments that run one script: cmd.exe on Windows, sh elsewhere. */
const script = (text: string) => (windows ? ['/d', '/v:on', '/s', '/c', text] : ['-c', text])
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'bun-native-processes-')))
const work = join(base, 'work')
mkdirSync(join(work, 'sub'), { recursive: true })
if (windows) {
  const junction = Bun.spawnSync([cmd, '/d', '/c', 'mklink', '/J', join(work, 'up'), base])
  if (!junction.success) throw new Error('mklink /J could not make the escape junction')
} else symlinkSync(base, join(work, 'up'))
const permissions = {
  processes: [
    { id: 'shell', executable: windows ? cmd : '/bin/sh' },
    {
      id: 'missing',
      executable: join(base, windows ? 'missing.exe' : 'missing'),
    },
  ],
  filesystemRoots: [{ id: 'work', path: work, access: 'read' as const }],
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
    .map(([pid, group, state]) => ({
      pid: Number(pid),
      group: Number(group),
      state: state!,
    }))
}

/** Command lines of the live ping.exe processes (Windows children carry a marker). */
function pings() {
  const listed = Bun.spawnSync([
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process -Filter "Name=\'PING.EXE\'" | ForEach-Object { $_.CommandLine }',
  ])
  if (!listed.success) throw new Error('Get-CimInstance could not list processes')
  return new TextDecoder().decode(listed.stdout)
}

/** A ping that runs for 30 s, found again by its unique -w timeout. */
function marked() {
  const marker = 1_000 + Math.floor(Math.random() * 8_000_000)
  return { marker, command: `ping -n 30 -w ${marker} 127.0.0.1` }
}

const markedAlive = (marker: number) => pings().includes(` -w ${marker} `)

async function markedStopped(marker: number) {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    if (!markedAlive(marker)) return true
    await Bun.sleep(50)
  }
  return false
}

/** The process group of a running process. */
function groupOf(pid: number) {
  if (macos) return psRows().find((row) => row.pid === pid)?.group
  return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[2])
}

/** True once no member of the group still runs: gone, or a zombie for init to reap. */
function groupStopped(group: number) {
  if (macos) return psRows().every((row) => row.group !== group || row.state.startsWith('Z'))
  for (const entry of new Bun.Glob('[0-9]*').scanSync({
    cwd: '/proc',
    onlyFiles: false,
  })) {
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

async function groupStopping(group: number) {
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
      backend: windows ? 'windows_job' : 'posix',
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

async function pipes(window: NativeWindow) {
  const grant = await window.openFileGrant('work')
  const seen = watch()
  const child = await window.spawnProcess(
    'shell',
    {
      args: windows
        ? script('echo out&(echo err)1>&2&echo [%HOME%][%BUN_X%]&cd&exit /b 5')
        : ['-c', 'printf out; printf err >&2; printf "|%s|%s|" "$HOME" "$BUN_X"; pwd -P; exit 5'],
      env: { BUN_X: 'a b' },
      cwd: { grant, path: 'sub' },
    },
    seen.listener
  )
  await seen.until(() => seen.exit !== undefined)
  assert.equal(child.terminal, false)
  assert.deepEqual(seen.exit, { code: 5 })
  if (windows) {
    // An unset variable stays unexpanded: HOME was not inherited.
    const [out, env, cwd] = (seen.streams['stdout'] ?? '').split('\r\n')
    assert.deepEqual([out, env], ['out', '[%HOME%][a b]'])
    assert.equal(cwd?.toLowerCase(), realpathSync.native(join(work, 'sub')).toLowerCase())
    assert.equal(seen.streams['stderr'], 'err\r\n')
  } else {
    assert.equal(seen.streams['stdout'], 'out||a b|' + realpathSync(join(work, 'sub')) + '\n')
    assert.equal(seen.streams['stderr'], 'err')
  }
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
      window.spawnProcess('shell', { args: script('exit'), cwd: { grant, path } }, () => {}),
      rejected(code)
    )
  await assert.rejects(
    window.spawnProcess('missing', {}, () => {}),
    rejected('not_found')
  )
  record('directoryAndExecutableFailuresAreTyped', {
    link: 'path_denied',
    missing: 'not_found',
  })
  await child.release()
  await grant.close()
}

/** Text a pseudo console rendered, without its VT control sequences. */
function rendered(text: string) {
  const ESC = 0x1b
  const BEL = 0x07
  let plain = ''
  let index = 0
  while (index < text.length) {
    if (text.charCodeAt(index) !== ESC) {
      plain += text[index++]
      continue
    }
    const kind = text[index + 1]
    index += 2
    if (kind === '[') {
      // CSI: parameters and intermediates, then one final byte in @..~.
      while (index < text.length && !/[@-~]/.test(text[index]!)) index++
      index++
    } else if (kind === ']') {
      // OSC: up to BEL or ESC \.
      while (
        index < text.length &&
        text.charCodeAt(index) !== BEL &&
        text.charCodeAt(index) !== ESC
      )
        index++
      index += text.charCodeAt(index) === ESC ? 2 : 1
    } else if (kind !== undefined && '()*+'.includes(kind)) index++ // a character set
  }
  return plain
}

/** Windows: a ConPTY sized, resized and typed into; mode con reports the size. */
async function windowsTerminal(window: NativeWindow) {
  const seen = watch()
  const child = await window.spawnProcess(
    'shell',
    {
      args: script('mode con&echo tty&set /p line=&mode con&echo got:!line!'),
      env: PATH,
      terminal: { columns: 90, rows: 12 },
    },
    seen.listener
  )
  const text = () => rendered(seen.streams['terminal'] ?? '')
  await seen.until(() => /Columns:\D*90/.test(text()) && text().includes('tty'))
  await child.resize({ columns: 100, rows: 30 })
  await child.write(new TextEncoder().encode('hello\r'))
  await seen.until(() => seen.exit !== undefined, 10_000)
  const sizes = [...text().matchAll(/Lines:\D*(\d+)\D*Columns:\D*(\d+)/g)].map(
    ([, rows, columns]) => `${rows} ${columns}`
  )
  assert.equal(sizes[0], '12 90', text())
  assert.equal(sizes.includes('30 100'), true, text())
  assert.equal(text().includes('got:hello'), true, text())
  assert.deepEqual(seen.exit, { code: 0 })
  assert.deepEqual(Object.keys(seen.streams), ['terminal'])
  record('terminalSizeResizeAndInput', { sizes })
  await child.release()
}

async function terminal(window: NativeWindow) {
  if (windows) return windowsTerminal(window)
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

/**
 * Windows: a pipe child has no console to interrupt and no hangup, so both
 * are refused; terminate ends the whole job, descendants included.
 */
async function windowsSignals(window: NativeWindow) {
  const seen = watch()
  const descendant = marked()
  const child = await window.spawnProcess(
    'shell',
    {
      args: script(`start /b ${descendant.command} >nul&echo ready&${marked().command} >nul`),
      env: PATH,
    },
    seen.listener
  )
  await seen.until(() => (seen.streams['stdout'] ?? '').includes('ready'))
  const deadline = performance.now() + 10_000
  while (!markedAlive(descendant.marker) && performance.now() < deadline) await Bun.sleep(50)
  assert.equal(markedAlive(descendant.marker), true)
  for (const refused of ['interrupt', 'hangup'] as const)
    await assert.rejects(child.signal(refused), rejected('service_unavailable'))
  await child.signal('terminate')
  await seen.until(() => seen.exit !== undefined)
  assert.deepEqual(seen.exit, { signal: 15 })
  assert.equal(await markedStopped(descendant.marker), true)
  await assert.rejects(child.signal('kill'), rejected('invalid_state'))
  record('jobSignalAndExitStopsDescendants', {
    exit: seen.exit,
    refused: ['interrupt', 'hangup'],
    descendantStopped: true,
  })
  await child.release()
}

async function signals(window: NativeWindow) {
  if (windows) return windowsSignals(window)
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
  assert.equal(await groupStopping(group!), true)
  await assert.rejects(child.signal('kill'), rejected('invalid_state'))
  record('groupSignalAndExitStopsDescendants', {
    exit: seen.exit,
    descendantStopped: true,
  })
  await child.release()
}

async function credit(window: NativeWindow) {
  let bytes = 0
  let chunks = 0
  let largest = 0
  const seen = watch()
  const zeros = join(base, 'zeros.bin')
  if (windows) writeFileSync(zeros, new Uint8Array(300_000).fill(0x7a))
  await window.spawnProcess(
    'shell',
    {
      args: windows ? script(`type ${zeros}`) : ['-c', 'head -c 300000 /dev/zero'],
      env: PATH,
    },
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
  const group = async (window: NativeWindow) => {
    const seen = watch()
    if (windows) {
      // The id is the marker of a ping that the job must stop.
      const { marker, command } = marked()
      const child = await window.spawnProcess(
        'shell',
        { args: script(`echo ready&${command} >nul`), env: PATH },
        seen.listener
      )
      await seen.until(() => (seen.streams['stdout'] ?? '').includes('ready'))
      const deadline = performance.now() + 10_000
      while (!markedAlive(marker) && performance.now() < deadline) await Bun.sleep(50)
      assert.equal(markedAlive(marker), true)
      return { child, id: marker }
    }
    const child = await window.spawnProcess(
      'shell',
      { args: ['-c', 'echo $$; exec sleep 30'], env: PATH },
      seen.listener
    )
    await seen.until(() => (seen.streams['stdout'] ?? '').endsWith('\n'))
    return { child, id: Number(seen.streams['stdout']!.trim()) }
  }
  const stopped = (id: number) => (windows ? markedStopped(id) : groupStopping(id))
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
        launch: {
          executable,
          args: windows ? script('ping -n 30 127.0.0.1 >nul') : ['-c', 'exec sleep 30'],
          env: PATH,
        },
      })
    await spawn(1, 5)
    const write = (window_id: number, process_id: number) =>
      native.send({
        type: 'write_process',
        window_id,
        process_id,
        data: 'eA==',
      })
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
            args: script('exit'),
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
        native.send({
          type: 'acknowledge_process_output',
          window_id: 1,
          process_id: 5,
          chunk: 1,
        })
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
  await withApp(async (_app, window) => {
    await pipes(window)
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
      backend: windows ? 'windows_job' : 'posix',
      kernel:
        macos || windows ? release() : readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(),
      display: macos
        ? 'macOS runner window session'
        : windows
          ? 'Windows runner interactive desktop'
          : 'isolated Xvfb with openbox',
      children: macos
        ? 'real /bin/sh programs; groups checked through ps; working directory through a grant descriptor (fchdir in the child)'
        : windows
          ? 'real cmd.exe programs in a job object; descendants checked through Get-CimInstance Win32_Process; working directory through an NTFS grant'
          : 'real /bin/sh programs; groups checked through /proc',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Owned process qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
