/** Prepared host identity checks, including Chromium's observed macOS hard-link lifecycle. */
import assert from 'node:assert/strict'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { assertCleanCommand, validateCommandObservation } from '../lib/observed-command.ts'

const numericFields = [
  'size',
  'mtimeNs',
  'ctimeNs',
  'device',
  'inode',
  'mode',
  'uid',
  'gid',
  'links',
] as const
export type PreparedFileMetadata = Readonly<
  { path: string } & Record<(typeof numericFields)[number], string>
>

function validPath(path: unknown): asserts path is string {
  assert.ok(
    typeof path === 'string' &&
      path.length > 0 &&
      path.length <= 4096 &&
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      !path.split('/').some((part) => part === '..' || part === '.' || part === ''),
    'Invalid prepared file path'
  )
}

export async function capturePreparedFileMetadata(
  root: string,
  entries: readonly { readonly path: string }[]
): Promise<readonly PreparedFileMetadata[]> {
  assert.ok(entries.length > 0 && entries.length < 16384)
  return Promise.all(
    entries.map(async ({ path }) => {
      validPath(path)
      const stat = await lstat(join(root, path), { bigint: true })
      assert.ok(stat.isFile() || stat.isSymbolicLink(), 'Unsupported prepared file kind')
      return {
        path,
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        mode: stat.mode.toString(),
        uid: stat.uid.toString(),
        gid: stat.gid.toString(),
        links: stat.nlink.toString(),
      }
    })
  )
}

function parse(input: unknown): PreparedFileMetadata[] {
  assert.ok(Array.isArray(input) && input.length > 0 && input.length < 16384)
  const paths = new Set<string>()
  for (const row of input) {
    assert.ok(row && typeof row === 'object' && !Array.isArray(row))
    assert.deepEqual(Object.keys(row).sort(), ['path', ...numericFields].sort())
    validPath(row.path)
    assert.ok(!paths.has(row.path), 'Duplicate prepared file identity')
    paths.add(row.path)
    for (const name of numericFields)
      assert.ok(
        typeof row[name] === 'string' && /^(?:0|[1-9][0-9]{0,23})$/.test(row[name]),
        `Invalid prepared file ${name}`
      )
    assert.ok(BigInt(row.links) > 0n, 'Prepared file has no filesystem link')
  }
  return input as PreparedFileMetadata[]
}

/** Full byte/mode/link-target inventories are checked separately. This check
 * additionally rejects same-content replacement, timestamp rewrites and changed
 * ownership. It is contributor accounting, not a hostile same-user race defense.
 */
export function acceptPreparedFileMetadata(options: {
  readonly before: unknown
  readonly after: unknown
  readonly hostPath: string
  readonly target: string
  readonly observations: readonly unknown[]
}) {
  const before = parse(options.before),
    after = parse(options.after)
  validPath(options.hostPath)
  assert.deepEqual(
    after.map((row) => row.path),
    before.map((row) => row.path),
    'Prepared file inventory changed'
  )
  assert.ok(
    before.some((row) => row.path === options.hostPath),
    'Prepared host identity missing'
  )
  const ctimeChangedPaths: string[] = []
  for (let index = 0; index < before.length; index++) {
    const old = before[index]!,
      current = after[index]!
    for (const field of numericFields)
      if (field !== 'ctimeNs')
        assert.equal(current[field], old[field], `Prepared file ${field} changed: ${old.path}`)
    if (current.ctimeNs !== old.ctimeNs) {
      // The existing observer verifies the new clone's device/inode against
      // this launched host and verifies its exact removal. link/unlink changes
      // ctime even when bytes, inode, permissions, mtime and final nlink agree.
      assert.equal(options.target, 'darwin-arm64', 'Unexpected prepared file status-time change')
      assert.equal(options.hostPath, 'Contents/MacOS/bunly_host')
      assert.equal(old.path, options.hostPath, 'Only the observed host may have a clone link')
      assert.equal(old.links, '1', 'Prepared host had an unrelated pre-existing hard link')
      assert.ok(BigInt(current.ctimeNs) > BigInt(old.ctimeNs), 'Host status time moved backwards')
      assert.ok(
        options.observations.length > 0 && options.observations.length <= 2,
        'Missing bounded clone lifecycle observation'
      )
      for (const input of options.observations) {
        const observation = validateCommandObservation(input)
        assertCleanCommand(observation)
        assert.equal(observation.environment['os'], 'Darwin')
        assert.equal(observation.postExitCleanup?.qualified, true, 'Clone removal was not proven')
        assert.equal(observation.postExitCleanup?.status, 'completed')
      }
      ctimeChangedPaths.push(old.path)
    }
  }
  return Object.freeze({
    identityUnchanged: true as const,
    ctimeChangedPaths: Object.freeze(ctimeChangedPaths),
    ctimeChangeReason: ctimeChangedPaths.length
      ? ('verified-macos-code-sign-clone-link-lifecycle' as const)
      : ('none' as const),
  })
}
