import { lstat, readdir, readlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
export interface InventoryEntry {
  path: string
  bytes: number
  kind: 'file' | 'symlink'
  sha256: string | null
  target?: string
}
export async function inventory(directory: string) {
  const root = resolve(directory)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Expected a real directory')
  const entries: InventoryEntry[] = []
  async function walk(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name)
      const stat = await lstat(full)
      const local = relative(root, full).split('\\').join('/')
      if (stat.isSymbolicLink())
        entries.push({
          path: local,
          bytes: 0,
          kind: 'symlink',
          sha256: null,
          target: await readlink(full),
        })
      else if (stat.isDirectory()) await walk(full)
      else if (stat.isFile()) {
        const digest = new Bun.CryptoHasher('sha256')
        let bytes = 0
        // Native file streaming bounds memory independently of CEF's binary size.
        for await (const chunk of Bun.file(full).stream()) {
          bytes += chunk.byteLength
          if (bytes > stat.size) throw new Error(`Inventory member changed: ${local}`)
          digest.update(chunk)
        }
        const after = await lstat(full)
        if (
          bytes !== stat.size ||
          after.isSymbolicLink() ||
          !after.isFile() ||
          after.dev !== stat.dev ||
          after.ino !== stat.ino ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw new Error(`Inventory member changed: ${local}`)
        entries.push({ path: local, bytes: stat.size, kind: 'file', sha256: digest.digest('hex') })
      } else throw new Error(`Unsupported inventory member: ${local}`)
    }
  }
  await walk(root)
  const groups = new Map<string, InventoryEntry[]>()
  for (const entry of entries)
    if (entry.sha256) {
      const group = groups.get(entry.sha256)
      if (group) group.push(entry)
      else groups.set(entry.sha256, [entry])
    }
  return {
    schema: 1,
    metric: 'logical-installed-file-bytes-no-symlink-traversal',
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
    duplicateContent: [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({ paths: group.map((entry) => entry.path), bytesPerCopy: group[0]!.bytes })),
    limitations: [
      'Not compressed installer size, allocated disk blocks, or RAM.',
      'Links are recorded but not traversed. Duplicate content is not proof of avoidable files.',
    ],
  }
}
