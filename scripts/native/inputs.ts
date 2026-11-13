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

type Input = { name: string; path: string; link: boolean }

/** The digest entry for one input, or undefined when it vanished or is not a file. */
async function inputDigest(
  directory: string,
  input: Input,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    // File links are hashed through their targets. Do not follow directory
    // links: recursive aliases can escape the project or introduce cycles.
    if (input.link && !(await stat(input.path)).isFile()) return undefined
    const target = input.link ? relative(directory, await realpath(input.path)) : null
    const contents = await Bun.file(input.path).bytes()
    signal?.throwIfAborted()
    return JSON.stringify([
      input.name,
      target,
      new Bun.CryptoHasher('sha256').update(contents).digest('hex'),
    ])
  } catch (error) {
    // Deletion/atomic replacement during a scan is an absent input; a
    // queued create/change event requests another scan. Other IO fails.
    if (!disappeared(error)) throw error
    return undefined
  }
}

// Enough concurrent reads to overlap file system latency without exhausting descriptors.
const READERS = 16

/** One content digest, with no retained file contents or earlier generations. */
export async function projectFingerprint(directory: string, signal?: AbortSignal): Promise<string> {
  const inputs: Input[] = []
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
      if (ignored.has(entry.name)) continue
      const path = join(folder, entry.name)
      const name = prefix + entry.name
      if (entry.isDirectory()) await visit(path, name + '/')
      else if (
        /\.(?:[cm]?[jt]s|[jt]sx|jsonc?|toml)$/.test(name) &&
        (entry.isFile() || entry.isSymbolicLink())
      )
        inputs.push({ name, path, link: entry.isSymbolicLink() })
    }
  }
  await visit(directory, '')
  // Read and hash files concurrently, then fold them in the sorted traversal order,
  // so the digest is identical to a serial scan.
  const digests: (string | undefined)[] = Array.from({ length: inputs.length })
  let next = 0
  const reader = async () => {
    for (let index = next++; index < inputs.length; index = next++) {
      signal?.throwIfAborted()
      digests[index] = await inputDigest(directory, inputs[index]!, signal)
    }
  }
  await Promise.all(Array.from({ length: Math.min(READERS, inputs.length) }, reader))
  signal?.throwIfAborted()
  const fingerprint = new Bun.CryptoHasher('sha256')
  for (const digest of digests) if (digest !== undefined) fingerprint.update(digest)
  return fingerprint.digest('hex')
}
