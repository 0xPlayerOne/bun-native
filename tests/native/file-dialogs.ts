/**
 * Real OS file dialog qualification: an isolated Xvfb + openbox session with
 * its own D-Bus session bus, xdg-desktop-portal and its GTK file chooser
 * backend. The dialogs are real GTK windows driven by XTest keyboard input;
 * an independent bus client forges portal responses that must be ignored.
 * Selected paths are compared as data; the test also checks that a save
 * selection does not create or write the file.
 */
import { createApplication, NativeServiceError, NativeStateError } from '@bun-native/core'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_DIALOG_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_DIALOG_MODE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !process.env['DISPLAY'] ||
  !process.env['DBUS_SESSION_BUS_ADDRESS'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error(
    'An isolated X11 display and D-Bus session, evidence directory, host and mode are required'
  )
const host = executable

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[], allowFailure = false): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0 && !allowFailure) throw new Error(`${command[0]} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 10_000
) {
  const until = performance.now() + timeout
  while (!(await check())) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(25)
  }
}

/** Visible top-level windows whose WM name is exactly `title`. */
async function windows(title: string): Promise<string[]> {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = await run(['xdotool', 'search', '--onlyvisible', '--name', `^${escaped}$`], true)
  return found ? found.split('\n') : []
}

/** The first visible window titled `title`, once it is mapped. */
async function dialog(title: string): Promise<string> {
  let id = ''
  await waitFor(async () => {
    id = (await windows(title))[0] ?? ''
    return Boolean(id)
  }, `the "${title}" dialog`)
  return id
}

const gone = (title: string) =>
  waitFor(async () => (await windows(title)).length === 0, `the "${title}" dialog to close`)

/** The OS dialog is transient for the owner's X11 window. */
async function transientFor(dialogId: string): Promise<number> {
  const property = await run(['xprop', '-id', dialogId, 'WM_TRANSIENT_FOR'])
  const match = /window id # (0x[0-9a-f]+)/i.exec(property)
  assert.ok(match, 'dialog has no WM_TRANSIENT_FOR: ' + property)
  return Number(match[1])
}

async function focus(id: string) {
  await run(['xdotool', 'windowactivate', '--sync', id], true)
  await run(['xdotool', 'windowfocus', '--sync', id])
  await Bun.sleep(300)
}

/** Type a location into the GTK chooser and accept it, as a user would. */
async function chooseLocation(id: string, location: string) {
  await focus(id)
  await run(['xdotool', 'key', '--window', id, 'ctrl+l'])
  await Bun.sleep(200)
  await run(['xdotool', 'type', '--delay', '5', location])
  await Bun.sleep(400)
  await run(['xdotool', 'key', 'Return'])
}

/** A dialog result within a bound; a timeout keeps a screenshot of the screen. */
async function result<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Timed out waiting for the ' + name + ' result')),
      10_000
    )
  })
  try {
    return await Promise.race([promise, expired])
  } catch (error) {
    await screenshot('timeout-' + name)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function screenshot(name: string) {
  await run(['import', '-window', 'root', join(output!, name + '.png')], true)
}

/** The xdg-desktop-portal frontend and GTK backend, owned by this test. */
async function startPortal(configHome: string) {
  mkdirSync(join(configHome, 'xdg-desktop-portal'), { recursive: true })
  writeFileSync(
    join(configHome, 'xdg-desktop-portal', 'portals.conf'),
    '[preferred]\ndefault=gtk\n'
  )
  // GTK records recent files; keep that state inside the owned test root.
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(configHome, 'data'),
    XDG_CACHE_HOME: join(configHome, 'cache'),
    XDG_STATE_HOME: join(configHome, 'state'),
    GTK_A11Y: 'none',
  }
  const backend = Bun.spawn(['/usr/libexec/xdg-desktop-portal-gtk', '--replace'], {
    env,
    stdout: 'ignore',
    stderr: Bun.file(join(output!, 'portal-gtk.log')),
  })
  await waitFor(() => hasOwner('org.freedesktop.impl.portal.desktop.gtk'), 'the GTK backend')
  const frontend = Bun.spawn(['/usr/libexec/xdg-desktop-portal', '--replace'], {
    env,
    stdout: 'ignore',
    stderr: Bun.file(join(output!, 'portal.log')),
  })
  await waitFor(() => hasOwner('org.freedesktop.portal.Desktop'), 'the portal frontend')
  return {
    async stop() {
      for (const child of [frontend, backend]) {
        child.kill()
        await child.exited
      }
    },
  }
}

async function hasOwner(name: string) {
  const reply = await run(
    [
      'dbus-send',
      '--session',
      '--print-reply',
      '--dest=org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner',
      'string:' + name,
    ],
    true
  )
  return reply.includes('boolean true')
}

/** The unique bus names of every connection owned by `pid`. */
async function busNames(pid: number): Promise<string[]> {
  const listed = await run([
    'dbus-send',
    '--session',
    '--print-reply',
    '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus',
    'org.freedesktop.DBus.ListNames',
  ])
  const names = [...listed.matchAll(/string "(:[^"]+)"/g)].map((match) => match[1]!)
  const owned: string[] = []
  for (const name of names) {
    const reply = await run(
      [
        'dbus-send',
        '--session',
        '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.GetConnectionUnixProcessID',
        'string:' + name,
      ],
      true
    )
    if (reply.includes('uint32 ' + pid)) owned.push(name)
  }
  return owned
}

/** A session bus with no portal and no service activation. */
async function emptyBus() {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-empty-bus-'))
  const config = join(directory, 'bus.conf')
  writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${directory}</listen>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`
  )
  const daemon = Bun.spawn(
    ['dbus-daemon', '--config-file=' + config, '--nofork', '--print-address=1'],
    { stdout: 'pipe', stderr: 'ignore' }
  )
  const reader = daemon.stdout.getReader()
  let address = ''
  while (!address.includes('\n')) {
    const { done, value } = await reader.read()
    if (done) throw new Error('isolated bus exited before reporting its address')
    address += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return {
    address: address.trim(),
    async stop() {
      daemon.kill()
      await daemon.exited
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

const isDialogError = (code: string) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === 'file_dialogs' && error.code === code

async function deniedByDefault() {
  const app = await createApplication({ executable: host })
  try {
    assert.deepEqual(app.serviceCapabilities.fileDialogs, {
      availability: 'available',
      permission: 'deny',
      scope: 'owned_window',
      backend: 'xdg_desktop_portal',
    })
    const window = await app.openWindow({ title: 'Dialog denial' })
    await assert.rejects(
      window.showOpenDialog({ title: 'Denied dialog' }),
      isDialogError('permission_denied')
    )
    await Bun.sleep(500)
    assert.deepEqual(await windows('Denied dialog'), [])
    record('nativeDefaultDenial', { code: 'permission_denied', dialogs: 0 })
  } finally {
    await app.shutdown()
    await app.closed
  }
}

async function noPortal() {
  const bus = await emptyBus()
  try {
    // The same host binary, launched on the isolated bus through env(1).
    const app = await createApplication({
      executable: '/usr/bin/env',
      args: ['DBUS_SESSION_BUS_ADDRESS=' + bus.address, host],
      permissions: { fileDialogs: 'allow' },
    })
    try {
      const window = await app.openWindow({ title: 'No portal' })
      await assert.rejects(
        window.showOpenDialog({ title: 'Nobody answers' }),
        isDialogError('service_unavailable')
      )
    } finally {
      await app.shutdown()
      await app.closed
    }
    record('noPortalUnavailable', { code: 'service_unavailable' })
  } finally {
    await bus.stop()
  }
}

async function qualify(files: string) {
  const app = await createApplication({ executable: host, permissions: { fileDialogs: 'allow' } })
  try {
    assert.equal(app.serviceCapabilities.fileDialogs.availability, 'available')
    const owner = await app.openWindow({ title: 'File dialog owner', width: 480, height: 320 })
    const ownerId = await dialog('File dialog owner')
    const hostPid = Number((await run(['xdotool', 'getwindowpid', ownerId])) || Number.NaN)

    // Open one file: a real GTK dialog parented to the owner window.
    const alpha = join(files, 'alpha one.txt')
    const opening = owner.showOpenDialog({
      title: 'Bun Native open file',
      acceptLabel: 'Choose',
      folder: files,
      filters: [{ name: 'Text', patterns: ['*.txt'] }],
    })
    const openId = await dialog('Bun Native open file')
    const parent = await transientFor(openId)
    assert.equal(parent, Number(ownerId))
    await screenshot('open-file-dialog')

    // An independent bus client forges a selection on the dialog's request
    // path. The portal did not send it, so it must not resolve the dialog.
    const names = Number.isFinite(hostPid) ? await busNames(hostPid) : []
    assert.ok(names.length > 0, 'host bus connection found')
    let forged = 0
    for (const name of names)
      for (let id = 1; id <= 4; id += 1) {
        const path = `/org/freedesktop/portal/desktop/request/${name.slice(1).replaceAll('.', '_')}/bun_native_${id}`
        await run([
          'gdbus',
          'emit',
          '--session',
          '--object-path',
          path,
          '--signal',
          'org.freedesktop.portal.Request.Response',
          '0',
          "{'uris': <['file:///forged.txt']>}",
        ])
        forged += 1
      }
    let settled = false
    const markSettled = () => {
      settled = true
    }
    void opening.then(markSettled, markSettled)
    await Bun.sleep(400)
    assert.equal(settled, false)
    assert.deepEqual(await windows('Bun Native open file'), [openId])
    record('forgedResponsesIgnored', { forged, delivered: 0 })

    await chooseLocation(openId, alpha)
    assert.deepEqual(await result(opening, 'open-file'), { kind: 'selected', paths: [alpha] })
    await gone('Bun Native open file')
    record('openFileSelected', { transientForOwner: true, paths: 1 })

    // Several files: GTK's own select-all in the starting folder's list.
    const batch = join(files, 'batch')
    const several = owner.showOpenDialog({
      title: 'Bun Native files',
      select: 'files',
      folder: batch,
    })
    const severalId = await dialog('Bun Native files')
    await focus(severalId)
    await run(['xdotool', 'key', 'ctrl+a'])
    await Bun.sleep(200)
    await run(['xdotool', 'key', 'Return'])
    const chosen = await result(several, 'files')
    assert.equal(chosen.kind, 'selected')
    assert.deepEqual(chosen.kind === 'selected' ? [...chosen.paths].sort() : [], [
      join(batch, 'one.txt'),
      join(batch, 'two.txt'),
    ])
    await gone('Bun Native files')
    record('openFilesSelected', { paths: 2 })

    // A folder: the dialog starts in the requested folder and its own accept
    // button (Alt+S, "_Select") chooses that current folder.
    const nested = join(files, 'nested')
    const folder = owner.showOpenDialog({
      title: 'Bun Native folder',
      select: 'directory',
      folder: nested,
    })
    const folderId = await dialog('Bun Native folder')
    await focus(folderId)
    await run(['xdotool', 'key', 'alt+s'])
    const chosenFolder = await result(folder, 'folder')
    assert.deepEqual(chosenFolder, { kind: 'selected', paths: [nested] })
    await gone('Bun Native folder')
    record('openDirectorySelected', { paths: 1 })

    // Save: the suggested name is accepted. Nothing is created or written.
    const target = join(files, 'report.txt')
    const saving = owner.showSaveDialog({
      title: 'Bun Native save',
      folder: files,
      name: 'report.txt',
    })
    const saveId = await dialog('Bun Native save')
    await focus(saveId)
    await run(['xdotool', 'key', 'Return'])
    assert.deepEqual(await result(saving, 'save'), { kind: 'selected', path: target })
    assert.equal(existsSync(target), false)
    await gone('Bun Native save')
    record('saveSelectedWithoutWriting', { created: false })

    // The user cancels with Escape.
    const escaping = owner.showOpenDialog({ title: 'Bun Native escape' })
    const escapeId = await dialog('Bun Native escape')
    await focus(escapeId)
    await run(['xdotool', 'key', 'Escape'])
    assert.deepEqual(await result(escaping, 'escape'), { kind: 'cancelled' })
    await gone('Bun Native escape')
    record('userCancelled', { kind: 'cancelled' })

    // Application cancellation closes the OS dialog through the portal.
    const controller = new AbortController()
    const aborted = owner.showOpenDialog(
      { title: 'Bun Native abort' },
      { signal: controller.signal }
    )
    await dialog('Bun Native abort')
    // One dialog per window while it is live.
    await assert.rejects(
      owner.showOpenDialog({ title: 'Bun Native second' }),
      isDialogError('limit_exceeded')
    )
    controller.abort()
    await assert.rejects(aborted, isDialogError('cancelled'))
    await gone('Bun Native abort')
    record('abortClosedDialog', { closed: true, secondDialog: 'limit_exceeded' })

    // Owner close closes its dialog without an application request.
    const other = await app.openWindow({ title: 'Second owner', width: 360, height: 200 })
    const closing = owner.showOpenDialog({ title: 'Bun Native owner close' })
    await dialog('Bun Native owner close')
    const revoked = assert.rejects(
      closing,
      (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
    )
    await owner.close()
    await revoked
    await gone('Bun Native owner close')
    record('ownerCloseClosedDialog', { closed: true })

    // Shutdown closes the remaining dialog.
    const remaining = other.showSaveDialog({ title: 'Bun Native shutdown' })
    await dialog('Bun Native shutdown')
    const stopped = assert.rejects(remaining, NativeStateError)
    await app.shutdown()
    await stopped
    await gone('Bun Native shutdown')
    record('shutdownClosedDialog', { closed: true })
  } finally {
    await app.shutdown()
    await app.closed
  }
  assert.deepEqual(Object.values(app.diagnostics), [0, 0, 0, 0, 0, 0, 0])
  record('ownershipReleased', app.diagnostics)
}

const root = mkdtempSync(join(tmpdir(), 'bun-native-dialogs-'))
const files = join(root, 'files')
mkdirSync(join(files, 'nested'), { recursive: true })
writeFileSync(join(files, 'alpha one.txt'), 'alpha\n')
mkdirSync(join(files, 'batch'))
writeFileSync(join(files, 'batch', 'one.txt'), 'one\n')
writeFileSync(join(files, 'batch', 'two.txt'), 'two\n')
const portal = await startPortal(join(root, 'config'))
try {
  await deniedByDefault()
  await noPortal()
  await qualify(files)
} finally {
  await portal.stop()
  rmSync(root, { recursive: true, force: true })
}

writeFileSync(
  join(output, 'file-dialogs.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      display: 'isolated Xvfb with openbox',
      bus: 'isolated D-Bus session bus',
      portal: (
        await run(['dpkg-query', '-W', 'xdg-desktop-portal', 'xdg-desktop-portal-gtk'], true)
      )
        .split('\n')
        .join(', '),
      input: 'XTest keyboard input into the real GTK file chooser',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('File dialog qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
