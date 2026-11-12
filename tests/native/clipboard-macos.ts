/**
 * Real macOS general-pasteboard qualification against the native host. The
 * independent oracle is the OS's own pasteboard tools: `pbcopy`/`pbpaste`
 * write and read plain text, and `osascript` (JavaScript for Automation)
 * clears every flavor. None of them loads GPUI, so a matching value is the
 * pasteboard server's, not the host's own echo. The pasteboard's previous
 * plain text is restored at the end.
 */
import { createApplication, NativeServiceError, NativeStateError } from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_CLIPBOARD_EVIDENCE']
const host = process.env['BUN_NATIVE_HOST']
if (
  process.platform !== 'darwin' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host)
)
  throw new Error('The macOS pasteboard fixture needs macOS, an evidence directory and a host')

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}
// pbcopy/pbpaste translate through the locale's encoding.
const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }

async function run(command: string[], input?: string): Promise<string> {
  const child = Bun.spawn(command, {
    env,
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim()}`)
  return stdout
}
const paste = () => run(['pbpaste', '-Prefer', 'txt'])
const copy = (text: string) => run(['pbcopy'], text)
/** Every flavor removed, as `-[NSPasteboard clearContents]` leaves it. */
const clear = () =>
  run([
    'osascript',
    '-l',
    'JavaScript',
    '-e',
    "ObjC.import('AppKit'); $.NSPasteboard.generalPasteboard.clearContents; ''",
  ])
const nonce = crypto.randomUUID()
const code = (expected: NativeServiceError['code']) => (error: unknown) =>
  error instanceof NativeServiceError && error.code === expected

const previous = await paste()
let failure: unknown
try {
  // 1. Without grants, both operations are denied before the pasteboard.
  {
    const sentinel = `sentinel ${nonce}`
    await copy(sentinel)
    const app = await createApplication({ executable: host })
    try {
      assert.deepEqual(app.serviceCapabilities.clipboardText, {
        availability: 'available',
        read: 'deny',
        write: 'deny',
        scope: 'owned_window',
        backend: 'appkit',
      })
      const window = await app.openWindow({ title: 'Pasteboard denied', width: 320, height: 200 })
      await assert.rejects(window.readClipboardText(), code('permission_denied'))
      await assert.rejects(window.writeClipboardText('denied'), code('permission_denied'))
      assert.equal(await paste(), sentinel)
    } finally {
      await app.shutdown()
      await app.closed
    }
    record('defaultDenial', true)
  }

  const app = await createApplication({
    executable: host,
    permissions: { clipboardRead: 'allow', clipboardWrite: 'allow' },
  })
  try {
    assert.equal(app.serviceCapabilities.clipboardText.availability, 'available')
    const window = await app.openWindow({ title: 'Pasteboard owner', width: 320, height: 200 })

    // 2. A write reaches the pasteboard server, read back by pbpaste.
    const written = `Bun Native ${nonce} é 漢字 🙂\nsecond line`
    await window.writeClipboardText(written)
    assert.equal(await paste(), written)
    record('writeSeenByPbpaste', true)

    // 3. Text another process copied is read exactly.
    const external = `external ${nonce} ü`
    await copy(external)
    assert.deepEqual(await window.readClipboardText(), { kind: 'text', text: external })
    record('readPbcopyText', true)

    // 4. A pasteboard without any plain-text flavor reads as empty.
    await clear()
    assert.deepEqual(await window.readClipboardText(), { kind: 'empty' })
    record('clearedReadsEmpty', true)

    // 5. Oversized text is refused, never truncated.
    await copy('x'.repeat(8_193))
    await assert.rejects(window.readClipboardText(), code('payload_too_large'))
    await copy('y'.repeat(8_192))
    assert.deepEqual(await window.readClipboardText(), { kind: 'text', text: 'y'.repeat(8_192) })
    record('boundedRead', true)

    // 6. An aborted request is never sent.
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(window.readClipboardText({ signal: controller.signal }), code('cancelled'))
    record('abortBeforeDispatch', true)

    // 7. A closed owner has no clipboard authority.
    const closing = await app.openWindow({ title: 'Pasteboard closing', width: 320, height: 200 })
    await closing.close()
    await assert.rejects(
      closing.readClipboardText(),
      (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
    )
    await assert.rejects(
      closing.writeClipboardText('stale'),
      (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
    )
    assert.equal(await paste(), 'y'.repeat(8_192))
    record('staleOwnerRejected', true)
  } finally {
    await app.shutdown()
    await app.closed
  }
  assert(Object.values(app.diagnostics).every((count) => count === 0))
  record('shutdownClean', true)
} catch (error) {
  failure = error
  throw error
} finally {
  await copy(previous).catch(() => {})
  writeFileSync(
    join(output, 'clipboard-macos.json'),
    JSON.stringify({ platform: process.platform, outcomes, failed: failure !== undefined }, null, 2)
  )
}
