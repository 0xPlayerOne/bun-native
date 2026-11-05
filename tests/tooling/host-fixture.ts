// Recognizable image headers exercise host selection only. These are deliberately
// incomplete images, never launched or presented as qualified native hosts.
export function hostHeader(platform: 'linux' | 'darwin' | 'win32', architecture: 'x64' | 'arm64') {
  const header = Buffer.alloc(256)
  if (platform === 'linux') {
    header.write('\x7fELF', 0)
    header[4] = 2 // ELFCLASS64
    header[5] = 1 // ELFDATA2LSB
    header[6] = 1 // EV_CURRENT
    header.writeUInt16LE(2, 16) // ET_EXEC
    header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18)
    header.writeUInt32LE(1, 20)
    header.writeUInt16LE(64, 52)
  } else if (platform === 'darwin') {
    header.writeUInt32LE(0xfeedfacf, 0) // MH_MAGIC_64
    header.writeUInt32LE(architecture === 'x64' ? 0x01000007 : 0x0100000c, 4)
    header.writeUInt32LE(2, 12) // MH_EXECUTE
  } else {
    header.write('MZ', 0)
    header.writeUInt32LE(128, 60)
    header.write('PE\0\0', 128)
    header.writeUInt16LE(architecture === 'x64' ? 0x8664 : 0xaa64, 132)
  }
  return header
}
