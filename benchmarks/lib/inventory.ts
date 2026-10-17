import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
export interface InventoryEntry { path: string; bytes: number; kind: 'file' | 'symlink'; sha256: string | null; target?: string }
export async function inventory(directory: string) {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Expected a real directory');
  const entries: InventoryEntry[] = [];
  async function walk(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name); const stat = await lstat(full); const local = relative(root, full).split('\\').join('/');
      if (stat.isSymbolicLink()) entries.push({ path: local, bytes: 0, kind: 'symlink', sha256: null, target: await readlink(full) });
      else if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) {
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(full)) digest.update(chunk as Buffer);
        entries.push({ path: local, bytes: stat.size, kind: 'file', sha256: digest.digest('hex') });
      } else throw new Error(`Unsupported inventory member: ${local}`);
    }
  }
  await walk(root);
  const groups = new Map<string, InventoryEntry[]>();
  for (const entry of entries) if (entry.sha256) groups.set(entry.sha256, [...(groups.get(entry.sha256) ?? []), entry]);
  return { schema: 1, metric: 'logical-installed-file-bytes-no-symlink-traversal',
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), entries,
    duplicateContent: [...groups.values()].filter(group => group.length > 1).map(group => ({ paths: group.map(entry => entry.path), bytesPerCopy: group[0]!.bytes })),
    limitations: ['Not compressed installer size, allocated disk blocks, or RAM.', 'Links are recorded but not traversed. Duplicate content is not proof of avoidable files.'] };
}
