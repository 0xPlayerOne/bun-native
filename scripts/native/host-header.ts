import type { FileHandle } from 'node:fs/promises'

/** Inspect the existing bounded header fields; the caller retains the read handle. */
export async function hasExecutableHeader(
  file: Pick<FileHandle, 'read'>,
  target: { platform: NodeJS.Platform; arch: NodeJS.Architecture }
): Promise<boolean> {
  const header = Buffer.alloc(64)
  const { bytesRead } = await file.read(header, 0, header.length, 0)
  if (bytesRead !== header.length) return false
  if (target.platform === 'linux')
    return (
      header.readUInt32LE(0) === 0x464c457f &&
      header[4] === 2 &&
      header[5] === 1 &&
      header.readUInt16LE(18) === (target.arch === 'arm64' ? 183 : 62)
    )
  if (target.platform === 'darwin')
    return (
      header.readUInt32LE(0) === 0xfeedfacf &&
      header.readUInt32LE(4) === (target.arch === 'arm64' ? 0x0100000c : 0x01000007)
    )
  if (target.platform === 'win32' && header.subarray(0, 2).toString() === 'MZ') {
    const pe = Buffer.alloc(6)
    const read = await file.read(pe, 0, pe.length, header.readUInt32LE(60))
    return (
      read.bytesRead === pe.length &&
      pe.readUInt32LE(0) === 0x00004550 &&
      pe.readUInt16LE(4) === (target.arch === 'arm64' ? 0xaa64 : 0x8664)
    )
  }
  return false
}
