import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type FileDigest = { bytes: number; sha256: string }

// Source files and manifests are read whole; compilers and host binaries are
// hashed through one reused buffer so memory stays bounded.
const WHOLE_FILE_BYTES = 4 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024

/** SHA-256 hex through Bun's native hasher; avoids loading node:crypto on CLI paths. */
export function sha256(data: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

export async function fileDigest(path: string): Promise<FileDigest> {
  const hash = new Bun.CryptoHasher('sha256')
  // The size only picks a strategy; both read to EOF and count what they read.
  if ((await stat(path)).size <= WHOLE_FILE_BYTES) {
    const data = await readFile(path)
    return { bytes: data.length, sha256: hash.update(data).digest('hex') }
  }
  let bytes = 0
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      bytes += bytesRead
    }
  } finally {
    await file.close()
  }
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * The digest of a large, rarely changing file (the compiler), reused from `cache`
 * while the file keeps its device, inode, size, mtime and ctime. Any write or
 * replacement changes one of those, and the file is hashed again.
 */
export async function cachedFileDigest(path: string, cache: string): Promise<FileDigest> {
  const identity = async () => {
    const stats = await stat(path, { bigint: true })
    return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':')
  }
  const before = await identity()
  try {
    const cached = await Bun.file(cache).json()
    if (
      cached?.path === path &&
      cached.identity === before &&
      Number.isSafeInteger(cached.digest?.bytes) &&
      /^[0-9a-f]{64}$/.test(cached.digest?.sha256)
    )
      return { bytes: cached.digest.bytes, sha256: cached.digest.sha256 }
  } catch {}
  const digest = await fileDigest(path)
  if ((await identity()) === before) {
    const partial = `${cache}.${process.pid}.partial`
    try {
      await mkdir(dirname(cache), { recursive: true })
      await writeFile(partial, JSON.stringify({ path, identity: before, digest }) + '\n')
      await rename(partial, cache)
    } catch {
      // The cache is optional; a read-only project hashes every time.
      await rm(partial, { force: true }).catch(() => {})
    }
  }
  return digest
}
