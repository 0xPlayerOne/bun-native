import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ignored = new Set(['node_modules', '.git', '.bun-native', 'dist', 'build'])

export function rescanInput(path: string | Buffer | null | undefined): boolean {
  // Missing names request a content rescan; they do not establish a source edit.
  if (path === null || path === undefined) return true
  const name = path.toString().replaceAll('\\', '/')
  // A name without an extension may be a directory being replaced or removed.
  // The snapshot decides whether relevant files actually changed.
  return !name.split('/').some((part) => ignored.has(part))
}

function disappeared(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/** One content digest, with no retained file contents or earlier generations. */
export async function projectFingerprint(directory: string, signal?: AbortSignal): Promise<string> {
  const fingerprint = createHash('sha256')
  const visit = async (folder: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted()
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      if (disappeared(error)) return
      throw error
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (ignored.has(entry.name)) continue
      const path = join(folder, entry.name)
      const name = prefix + entry.name
      if (entry.isDirectory()) await visit(path, name + '/')
      else if (/\.(?:[cm]?[jt]s|[jt]sx|jsonc?|toml)$/.test(name)) {
        try {
          // File links are hashed through their targets. Do not follow directory
          // links: recursive aliases can escape the project or introduce cycles.
          if (!entry.isFile() && !(entry.isSymbolicLink() && (await stat(path)).isFile())) continue
          const target = entry.isSymbolicLink() ? relative(directory, await realpath(path)) : null
          const contents = createHash('sha256')
          for await (const chunk of createReadStream(path, { signal })) contents.update(chunk)
          signal?.throwIfAborted()
          fingerprint.update(JSON.stringify([name, target, contents.digest('hex')]))
        } catch (error) {
          // Deletion/atomic replacement during a scan is an absent input; a
          // queued create/change event requests another scan. Other IO fails.
          if (!disappeared(error)) throw error
        }
      }
    }
  }
  await visit(directory, '')
  signal?.throwIfAborted()
  return fingerprint.digest('hex')
}
