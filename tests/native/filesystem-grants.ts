/**
 * Real filesystem grant qualification against the native host: on Linux on an
 * isolated X11 display, on macOS in the runner's own GUI session. Every effect is checked independently through node:fs on a
 * private temporary tree, including a sibling directory the grants must never
 * reach. Raw protocol checks drive the same host through the private runtime
 * to prove foreign, stale and reused grant handles are rejected natively.
 */
import { createApplication, NativeServiceError, type NativeFileGrant } from '@bun-native/core'
import { NativeCommandError, NativeHost } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { release, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_FILESYSTEM_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_FILESYSTEM_MODE']
const macos = process.platform === 'darwin'
if (process.platform !== 'linux' && !macos)
  throw new Error('Filesystem grants are qualified only on Linux and macOS')
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
const backend = macos ? 'openat_walk' : 'openat2'

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

const rejectsWith = (service: string, code: string) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === service && error.code === code
const denied = (code: string) => rejectsWith('filesystem_grants', code)

// macOS reaches its temporary directory through the /var link; name the real tree.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'bun-native-grants-')))
const work = join(base, 'work')
const docs = join(base, 'docs')
const outside = join(base, 'outside')
for (const directory of [work, docs, outside]) mkdirSync(directory)
writeFileSync(join(outside, 'secret'), 'outside')
writeFileSync(join(docs, 'readme.txt'), 'read only')
symlinkSync(join(outside, 'secret'), join(work, 'escape'))
symlinkSync(outside, join(work, 'outside-dir'))
mkdirSync(join(work, 'inner'))
symlinkSync(join(work, 'inner'), join(work, 'inner-link'))
const outsideBefore = readdirSync(outside)

const roots = [
  { id: 'work', path: work, access: 'read_write' },
  { id: 'docs', path: docs, access: 'read' },
] as const

async function deniedByDefault() {
  const app = await createApplication({ executable: host })
  try {
    assert.deepEqual(app.serviceCapabilities.filesystemGrants, {
      availability: 'available',
      roots: {},
      scope: 'owned_window',
      backend,
    })
    const window = await app.openWindow({ title: 'Grant denial' })
    await assert.rejects(window.openFileGrant('work'), denied('permission_denied'))
    record('nativeDefaultDenial', { code: 'permission_denied' })
  } finally {
    await app.shutdown()
    await app.closed
  }
}

async function readOnly(grant: NativeFileGrant) {
  const chunk = await grant.read('readme.txt')
  assert.equal(new TextDecoder().decode(chunk.bytes), 'read only')
  assert.equal(chunk.endOfFile, true)
  for (const write of [
    () => grant.write('new.txt', new Uint8Array([1])),
    () => grant.createDirectory('folder'),
    () => grant.remove('readme.txt'),
  ])
    await assert.rejects(write(), denied('permission_denied'))
  assert.deepEqual(readdirSync(docs), ['readme.txt'])
  record('readGrantRefusesWrites', { files: readdirSync(docs) })
}

async function readWrite(grant: NativeFileGrant) {
  const encoder = new TextEncoder()
  assert.equal(await grant.write('notes.txt', encoder.encode('hello')), 5)
  await assert.rejects(grant.write('notes.txt', encoder.encode('x')), denied('already_exists'))
  await grant.write('notes.txt', encoder.encode(' world'), { mode: 'append' })
  assert.equal(readFileSync(join(work, 'notes.txt'), 'utf8'), 'hello world')
  const tail = await grant.read('notes.txt', { offset: 6, length: 64 })
  assert.equal(new TextDecoder().decode(tail.bytes), 'world')
  assert.equal(tail.endOfFile, true)
  const head = await grant.read('notes.txt', { length: 5 })
  assert.deepEqual([new TextDecoder().decode(head.bytes), head.endOfFile], ['hello', false])
  await grant.write('notes.txt', encoder.encode('new'), { mode: 'truncate' })
  assert.equal(readFileSync(join(work, 'notes.txt'), 'utf8'), 'new')
  const stat = await grant.stat('notes.txt')
  assert.equal(stat.kind, 'file')
  assert.equal(stat.size, 3)
  assert.equal(Math.abs(stat.modifiedMs - statSync(join(work, 'notes.txt')).mtimeMs) < 1, true)

  // Binary chunks round-trip byte for byte at the chunk bound.
  const binary = new Uint8Array(16_384).map((_, index) => (index * 31) & 0xff)
  await grant.write('binary.bin', binary)
  assert.deepEqual(new Uint8Array(readFileSync(join(work, 'binary.bin'))), binary)
  assert.deepEqual((await grant.read('binary.bin')).bytes, binary)
  record('actualFileEffects', { notes: 'new', binaryBytes: binary.byteLength })

  // Directories, pages and removal.
  await grant.createDirectory('many')
  for (let index = 0; index < 70; index++)
    await grant.write('many/f' + String(index).padStart(2, '0'), new Uint8Array())
  const first = await grant.list('many')
  assert.equal(first.entries.length, 64)
  assert.equal(first.complete, false)
  const second = await grant.list('many', { after: first.entries.at(-1)!.name })
  assert.deepEqual(
    [...first.entries, ...second.entries].map((entry) => entry.name),
    readdirSync(join(work, 'many')).sort()
  )
  assert.equal(second.complete, true)
  await assert.rejects(grant.remove('many'), denied('not_empty'))
  for (const entry of [...first.entries, ...second.entries])
    await grant.remove('many/' + entry.name)
  await grant.remove('many')
  assert.equal(existsSync(join(work, 'many')), false)
  record('directoryPagesAndRemoval', { pages: [first.entries.length, second.entries.length] })

  // Symbolic links are never followed, inside or out of the grant.
  for (const path of ['escape', 'outside-dir/secret', 'inner-link'])
    await assert.rejects(grant.read(path), denied('path_denied'), path)
  await assert.rejects(
    grant.write('escape', encoder.encode('x'), { mode: 'truncate' }),
    denied('path_denied')
  )
  await assert.rejects(grant.list('outside-dir'), denied('path_denied'))
  assert.equal((await grant.stat('escape')).kind, 'symlink')
  const listing = await grant.list()
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.kind]),
    [
      ['binary.bin', 'file'],
      ['escape', 'symlink'],
      ['inner', 'directory'],
      ['inner-link', 'symlink'],
      ['notes.txt', 'file'],
      ['outside-dir', 'symlink'],
    ]
  )
  // Removing a link removes only the entry.
  await grant.remove('escape')
  assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'outside')
  // Traversal and absolute names never reach the wire.
  for (const path of ['../outside/secret', '/etc/passwd', 'inner/../notes.txt', 'a//b', '.'])
    await assert.rejects(grant.read(path), TypeError, path)
  await assert.rejects(grant.read('missing'), denied('not_found'))
  await assert.rejects(grant.read('inner'), denied('wrong_kind'))
  assert.deepEqual(readdirSync(outside), outsideBefore)
  record('confinement', { symlinks: 'path_denied', traversal: 'TypeError', outside: 'unchanged' })
}

async function lifecycle() {
  const app = await createApplication({ executable: host, permissions: { filesystemRoots: roots } })
  try {
    assert.deepEqual(app.serviceCapabilities.filesystemGrants, {
      availability: 'available',
      roots: { work: { access: 'read_write' }, docs: { access: 'read' } },
      scope: 'owned_window',
      backend,
    })
    const owner = await app.openWindow({ title: 'Grant owner', width: 360, height: 200 })
    await assert.rejects(owner.openFileGrant('other'), denied('permission_denied'))
    await assert.rejects(
      owner.openFileGrant('docs', { access: 'read_write' }),
      denied('permission_denied')
    )
    await readOnly(await owner.openFileGrant('docs'))
    const grant = await owner.openFileGrant('work', { access: 'read_write' })
    await readWrite(grant)

    // Closing revokes locally first: an in-flight result is withheld.
    const pending = grant.read('notes.txt')
    await grant.close()
    await assert.rejects(pending, denied('cancelled'))
    await assert.rejects(grant.stat('notes.txt'), denied('cancelled'))
    assert.equal(grant.active, false)
    record('closeRevokes', { active: grant.active })

    // The descriptor names the directory chosen at grant time.
    const renamed = await owner.openFileGrant('work')
    renameSync(work, work + '-moved')
    try {
      assert.equal((await renamed.stat('notes.txt')).size, 3)
    } finally {
      renameSync(work + '-moved', work)
    }
    record('renamedRootKeepsDirectory', { size: 3 })

    // Closing the owner window revokes its grants.
    const windowGrant = await owner.openFileGrant('work')
    await owner.close()
    assert.equal(windowGrant.active, false)
    await assert.rejects(windowGrant.stat('notes.txt'), denied('cancelled'))
    record('ownerCloseRevokes', { active: windowGrant.active })

    const survivor = await (await app.openWindow({ title: 'Survivor' })).openFileGrant('docs')
    return survivor
  } finally {
    await app.shutdown()
    await app.closed
    assert.deepEqual(Object.values(app.diagnostics), [0, 0, 0, 0, 0, 0, 0])
  }
}

/** Raw protocol checks: the host itself rejects foreign, stale and reused grants. */
async function rawHandles() {
  const native = await NativeHost.launch({
    executable: host,
    permissions: { filesystemRoots: roots },
  })
  const code = (operation: Promise<unknown>) =>
    operation.then(
      () => 'accepted',
      (error: unknown) => (error instanceof NativeCommandError ? error.code : String(error))
    )
  try {
    const open = (window_id: number, root_id: number) =>
      native.send({
        type: 'open',
        window_id,
        root_id,
        title: 'Raw ' + window_id,
        width: 200,
        height: 120,
      })
    await open(1, 1)
    await open(2, 2)
    const stat = (window_id: number, grant_id: number) =>
      native.send({
        type: 'file_request',
        window_id,
        grant_id,
        path: 'notes.txt',
        operation: { kind: 'stat' },
      })
    await native.send({
      type: 'open_file_grant',
      window_id: 1,
      grant_id: 5,
      root: 'work',
      access: 'read',
    })
    const results = {
      foreignWindow: await code(stat(2, 5)),
      unknownGrant: await code(stat(1, 6)),
      reusedId: await code(
        native.send({
          type: 'open_file_grant',
          window_id: 2,
          grant_id: 5,
          root: 'work',
          access: 'read',
        })
      ),
      lowerId: await code(
        native.send({
          type: 'open_file_grant',
          window_id: 2,
          grant_id: 4,
          root: 'work',
          access: 'read',
        })
      ),
      readOnlyWrite: await code(
        native.send({
          type: 'file_request',
          window_id: 1,
          grant_id: 5,
          path: 'x',
          operation: { kind: 'create_directory' },
        })
      ),
    }
    await native.send({ type: 'close_file_grant', window_id: 1, grant_id: 5 })
    Object.assign(results, {
      staleGrant: await code(stat(1, 5)),
      staleClose: await code(native.send({ type: 'close_file_grant', window_id: 1, grant_id: 5 })),
    })
    assert.deepEqual(results, {
      foreignWindow: 'invalid_handle',
      unknownGrant: 'invalid_handle',
      reusedId: 'invalid_handle',
      lowerId: 'invalid_handle',
      readOnlyWrite: 'permission_denied',
      staleGrant: 'invalid_handle',
      staleClose: 'invalid_handle',
    })
    assert.equal(existsSync(join(work, 'x')), false)
    record('nativeHandleChecks', results)
  } finally {
    await native.shutdown()
  }
}

try {
  await deniedByDefault()
  const survivor = await lifecycle()
  assert.equal(survivor.active, false)
  await assert.rejects(survivor.stat('readme.txt'), denied('cancelled'))
  record('shutdownRevokes', { active: survivor.active })
  await rawHandles()
  assert.deepEqual(readdirSync(outside), outsideBefore)
  assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'outside')
  record('outsideUntouched', { entries: readdirSync(outside) })
} finally {
  rmSync(base, { recursive: true, force: true })
}

writeFileSync(
  join(output, 'filesystem-grants.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      platform: process.platform,
      backend,
      kernel: macos ? release() : readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(),
      display: macos ? 'hosted macOS runner GUI session' : 'isolated Xvfb with openbox',
      filesystem: 'private temporary tree, independently checked with node:fs',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Filesystem grant qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
