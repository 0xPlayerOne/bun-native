import { expect, test } from 'bun:test'
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasExecutableHeader } from '../../scripts/native/host-header.ts'
import { hostHeader } from './host-fixture.ts'

const platforms = ['linux', 'darwin', 'win32'] as const
const architectures = ['x64', 'arm64'] as const

async function image(bytes: Buffer, exercise: (file: FileHandle) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-header-unit-'))
  try {
    const path = join(directory, 'inert-header')
    await writeFile(path, bytes)
    const file = await open(path, 'r')
    try {
      await exercise(file)
    } finally {
      await file.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

for (const platform of platforms) {
  for (const arch of architectures) {
    test('read-only header selection for ' + platform + '/' + arch, async () => {
      await image(hostHeader(platform, arch), async (file) => {
        for (const targetPlatform of platforms)
          for (const targetArch of architectures)
            expect(
              await hasExecutableHeader(file, { platform: targetPlatform, arch: targetArch })
            ).toBe(platform === targetPlatform && arch === targetArch)
        expect(await hasExecutableHeader(file, { platform: 'freebsd', arch })).toBe(false)
        // The production caller owns closing, including after an incompatible result.
        expect((await file.stat()).size).toBe(256)
      })
    })
  }

  test('rejects a truncated ' + platform + ' leading header', async () => {
    for (const length of [0, 3, 18, 63])
      await image(hostHeader(platform, 'x64').subarray(0, length), async (file) => {
        expect(await hasExecutableHeader(file, { platform, arch: 'x64' })).toBe(false)
      })
  })
}

test('rejects ELF magic, class, endianness and machine mismatches', async () => {
  for (const change of [
    (header: Buffer) => header.writeUInt32LE(0, 0),
    (header: Buffer) => (header[4] = 1),
    (header: Buffer) => (header[5] = 2),
    (header: Buffer) => header.writeUInt16LE(3, 18),
  ]) {
    const header = hostHeader('linux', 'x64')
    change(header)
    await image(header, async (file) => {
      expect(await hasExecutableHeader(file, { platform: 'linux', arch: 'x64' })).toBe(false)
    })
  }
})

test('rejects fat, 32-bit, byte-swapped and wrong-machine Mach-O headers', async () => {
  for (const change of [
    (header: Buffer) => header.writeUInt32LE(0xcafebabe, 0),
    (header: Buffer) => header.writeUInt32LE(0xfeedface, 0),
    (header: Buffer) => header.writeUInt32LE(0xcffaedfe, 0),
    (header: Buffer) => header.writeUInt32LE(7, 4),
  ]) {
    const header = hostHeader('darwin', 'x64')
    change(header)
    await image(header, async (file) => {
      expect(await hasExecutableHeader(file, { platform: 'darwin', arch: 'x64' })).toBe(false)
    })
  }
})

test('rejects malformed DOS/PE signatures, machines, offsets and short COFF reads', async () => {
  for (const change of [
    (header: Buffer) => header.write('NZ', 0),
    (header: Buffer) => header.writeUInt32LE(0, 128),
    (header: Buffer) => header.writeUInt16LE(0x014c, 132),
    (header: Buffer) => header.writeUInt32LE(0xfffffff0, 60),
  ]) {
    const header = hostHeader('win32', 'x64')
    change(header)
    await image(header, async (file) => {
      expect(await hasExecutableHeader(file, { platform: 'win32', arch: 'x64' })).toBe(false)
    })
  }
  for (const length of [128, 129, 132, 133])
    await image(hostHeader('win32', 'x64').subarray(0, length), async (file) => {
      expect(await hasExecutableHeader(file, { platform: 'win32', arch: 'x64' })).toBe(false)
    })
})

test('propagates reader errors instead of classifying an unreadable file', async () => {
  await image(hostHeader('linux', 'x64'), async (file) => {
    await file.close()
    await expect(hasExecutableHeader(file, { platform: 'linux', arch: 'x64' })).rejects.toThrow()
  })
})
