import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export type FileDigest = { bytes: number; sha256: string }

export async function fileDigest(path: string): Promise<FileDigest> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { bytes, sha256: hash.digest('hex') }
}
