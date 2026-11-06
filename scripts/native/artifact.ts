import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'

export type FileDigest = { bytes: number; sha256: string }

// Source files and manifests are read whole; compilers and host binaries are
// hashed through one reused buffer so memory stays bounded.
const WHOLE_FILE_BYTES = 4 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024

export async function fileDigest(path: string): Promise<FileDigest> {
  const hash = createHash('sha256')
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
