/**
 * Real macOS file dialog qualification against the native host. The host
 * attaches an `NSOpenPanel` or `NSSavePanel` sheet to the owner window and an
 * independent Accessibility oracle (macos-file-panel-oracle.m) finds it by its
 * title, reads its buttons and fields, and presses its buttons. The oracle
 * never loads GPUI, so a result comes from a real accessibility press of the
 * panel's own button, not a synthesized host event.
 *
 * What is pressed: Cancel on a file panel, the accept button of a folder panel
 * started in a known folder (which chooses that folder), and the accept button
 * of a save panel with a suggested name (which chooses that name there). Picking
 * an individual file in the panel's browser is not automated here.
 *
 * A save panel shows a suggested name with a known extension without that
 * extension unless the user chose to show all filename extensions (Finder's
 * `AppleShowAllExtensions` in the global domain); the chosen path keeps it
 * either way. The workflow sets that preference so the name field shows the
 * whole name, and this fixture refuses to run without it rather than accept a
 * truncated name.
 */
import { createApplication, NativeServiceError, NativeStateError } from '@bun-native/core'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_FILE_DIALOG_EVIDENCE']
const host = process.env['BUN_NATIVE_HOST']
const oracle = process.env['BUN_NATIVE_FILE_PANEL_ORACLE']
if (
  process.platform !== 'darwin' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  !oracle ||
  !isAbsolute(oracle)
)
  throw new Error('macOS file dialogs need macOS, an evidence directory, a host and an oracle')

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

/** The host is this process's direct child; found once, while it runs. */
let hostPid: number | undefined
async function pid(): Promise<number> {
  if (hostPid !== undefined) return hostPid
  const children = (await run(['pgrep', '-P', String(process.pid)])).stdout
    .split('\n')
    .filter(Boolean)
  for (const child of children) {
    const command = (await run(['ps', '-o', 'comm=', '-p', child])).stdout
    if (command === host || command.endsWith('/bun-native-host')) return (hostPid = Number(child))
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

type Sheet = { texts: string[]; buttons: string[]; fields: string[] }
async function ui(command: 'find' | 'absent' | 'invoke', title: string, button?: string) {
  const argv = [oracle!, command, String(await pid()), title, ...(button ? [button] : [])]
  const result = await run(argv)
  if (result.code !== 0)
    throw new Error(`oracle ${command} ${title} exited ${result.code}: ${result.stderr}`)
  return JSON.parse(result.stdout) as unknown
}
const find = async (title: string) => (await ui('find', title)) as Sheet

const isDialogError = (code: NativeServiceError['code']) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === 'file_dialogs' && error.code === code
const nonce = crypto.randomUUID().slice(0, 8)
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'bun-native-panels-')))
writeFileSync(join(folder, 'note.txt'), 'note\n')

let failure: unknown
try {
  assert.equal(JSON.parse((await run([oracle, 'trusted'])).stdout).trusted, true)
  const extensions = await run(['defaults', 'read', '-g', 'AppleShowAllExtensions'])
  assert.equal(
    extensions.stdout,
    '1',
    'Run with `defaults write -g AppleShowAllExtensions -bool true`: otherwise the save panel hides the suggested extension'
  )

  // 1. Without the grant no panel is shown.
  {
    const denied = await createApplication({ executable: host })
    try {
      assert.deepEqual(denied.serviceCapabilities.fileDialogs, {
        availability: 'available',
        permission: 'deny',
        scope: 'owned_window',
        backend: 'appkit',
      })
      const window = await denied.openWindow({ title: 'Panel denial', width: 320, height: 200 })
      await assert.rejects(
        window.showOpenDialog({ title: `Denied ${nonce}` }),
        isDialogError('permission_denied')
      )
    } finally {
      await denied.shutdown()
      await denied.closed
    }
    record('defaultDenial', true)
  }

  const app = await createApplication({ executable: host, permissions: { fileDialogs: 'allow' } })
  try {
    assert.deepEqual(app.serviceCapabilities.fileDialogs, {
      availability: 'available',
      permission: 'allow',
      scope: 'owned_window',
      backend: 'appkit',
    })
    const owner = await app.openWindow({ title: 'Panel owner', width: 640, height: 480 })
    await pid()

    // 2. A file panel shows its title and accept label; Cancel cancels it.
    {
      const title = `Open text ${nonce}`
      const pending = owner.showOpenDialog({
        title,
        acceptLabel: 'Use Text',
        folder,
        filters: [{ name: 'Text', patterns: ['*.txt'] }],
      })
      const sheet = await find(title)
      for (const button of ['Cancel', 'Use Text'])
        assert(sheet.buttons.includes(button), `${button} missing from ${sheet.buttons.join(', ')}`)
      await ui('invoke', title, 'Cancel')
      assert.deepEqual(await pending, { kind: 'cancelled' })
      await ui('absent', title)
      record('openCancelled', { buttons: sheet.buttons })
    }

    // 3. A folder panel started in a folder chooses that folder.
    {
      const title = `Choose folder ${nonce}`
      const pending = owner.showOpenDialog({
        title,
        select: 'directory',
        acceptLabel: 'Choose Here',
        folder,
      })
      await find(title)
      await ui('invoke', title, 'Choose Here')
      const result = await pending
      assert.equal(result.kind, 'selected')
      if (result.kind === 'selected') {
        assert.equal(result.paths.length, 1)
        assert.equal(realpathSync(result.paths[0]!), folder)
      }
      await ui('absent', title)
      record('folderSelected', true)
    }

    // 4. A save panel chooses the suggested name in the folder; nothing is written.
    {
      const title = `Save report ${nonce}`
      const name = `report-${nonce}.txt`
      const pending = owner.showSaveDialog({ title, acceptLabel: 'Export', folder, name })
      const sheet = await find(title)
      assert(sheet.fields.includes(name), `${name} missing from fields ${sheet.fields.join(', ')}`)
      await ui('invoke', title, 'Export')
      const result = await pending
      // NSSavePanel reports the folder's unresolved path (/var for
      // /private/var), as the open panel does above; compare the location.
      assert(result.kind === 'selected', `unexpected save result ${JSON.stringify(result)}`)
      assert.deepEqual(Object.keys(result).sort(), ['kind', 'path'])
      assert.equal(basename(result.path), name)
      assert.equal(realpathSync(dirname(result.path)), folder)
      assert.equal(existsSync(join(folder, name)), false)
      await ui('absent', title)
      record('saveSelected', { fields: sheet.fields })
    }

    // 5. A glob a panel cannot honor is refused before anything is shown.
    {
      const title = `Unsupported filter ${nonce}`
      await assert.rejects(
        owner.showOpenDialog({ title, filters: [{ name: 'Logs', patterns: ['app-*.log'] }] }),
        isDialogError('service_unavailable')
      )
      await ui('absent', title)
      record('unsupportedFilterRefused', true)
    }

    // 6. Abort ends the sheet; a second dialog is refused while one is live.
    {
      const title = `Abort ${nonce}`
      const controller = new AbortController()
      const aborted = owner.showOpenDialog({ title }, { signal: controller.signal })
      await find(title)
      await assert.rejects(
        owner.showOpenDialog({ title: `Second ${nonce}` }),
        isDialogError('limit_exceeded')
      )
      controller.abort()
      await assert.rejects(aborted, isDialogError('cancelled'))
      await ui('absent', title)
      record('abortClosesSheet', { secondDialog: 'limit_exceeded' })
    }

    // 7. Owner close ends its sheet and rejects the caller.
    {
      const title = `Owner close ${nonce}`
      const closing = await app.openWindow({ title: 'Panel closing', width: 640, height: 480 })
      const pending = closing.showSaveDialog({ title })
      await find(title)
      const revoked = assert.rejects(
        pending,
        (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
      )
      await closing.close()
      await revoked
      await ui('absent', title)
      record('ownerCloseEndsSheet', true)
    }

    // 8. Shutdown ends the remaining sheet.
    {
      const title = `Shutdown ${nonce}`
      const remaining = owner.showOpenDialog({ title, select: 'files' })
      await find(title)
      const stopped = assert.rejects(remaining, NativeStateError)
      await app.shutdown()
      await stopped
      await ui('absent', title)
      record('shutdownEndsSheet', true)
    }
  } finally {
    await app.shutdown()
    await app.closed
  }
  assert(Object.values(app.diagnostics).every((count) => count === 0))
  record('ownershipReleased', app.diagnostics)
} catch (error) {
  failure = error
  throw error
} finally {
  rmSync(folder, { recursive: true, force: true })
  writeFileSync(
    join(output, 'file-dialogs-macos.json'),
    JSON.stringify({ platform: process.platform, outcomes, failed: failure !== undefined }, null, 2)
  )
}
