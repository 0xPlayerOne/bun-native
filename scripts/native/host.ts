import { constants } from 'node:fs'
import { access, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export async function prebuiltHost(path: string | undefined): Promise<string> {
  if (!path || !isAbsolute(path))
    throw new Error(
      '--host must be an absolute path to an existing prebuilt native host; this command never runs Cargo or downloads a host'
    )
  const host = await realpath(path)
  if (!(await stat(host)).isFile()) throw new Error('The prebuilt native host must be a file')
  await access(host, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK))
  const file = await open(host, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    let compatible = false
    if (bytesRead === header.length) {
      if (process.platform === 'linux')
        compatible =
          header.readUInt32LE(0) === 0x464c457f &&
          header[4] === 2 &&
          header[5] === 1 &&
          header.readUInt16LE(18) === (process.arch === 'arm64' ? 183 : 62)
      else if (process.platform === 'darwin')
        compatible =
          header.readUInt32LE(0) === 0xfeedfacf &&
          header.readUInt32LE(4) === (process.arch === 'arm64' ? 0x0100000c : 0x01000007)
      else if (process.platform === 'win32' && header.subarray(0, 2).toString() === 'MZ') {
        const pe = Buffer.alloc(6)
        const read = await file.read(pe, 0, pe.length, header.readUInt32LE(60))
        compatible =
          read.bytesRead === pe.length &&
          pe.readUInt32LE(0) === 0x00004550 &&
          pe.readUInt16LE(4) === (process.arch === 'arm64' ? 0xaa64 : 0x8664)
      }
    }
    if (!compatible)
      throw new Error(`Prebuilt host must be a ${process.platform}/${process.arch} executable`)
  } finally {
    await file.close()
  }
  return host
}
