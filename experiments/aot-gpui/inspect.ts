import { readFileSync } from 'node:fs'

// Layout is pinned to Bun da867c60: src/standalone_graph/StandaloneModuleGraph.rs
// Offsets is repr(C), 32 bytes on all six supported 64-bit targets. A .bun_aot
// section also exists in JIT executables; the actual module graph flag matters.
const trailer = Buffer.from('\n---- Bun! ----\n')
const offsetsSize = 32
const moduleRecordSize = 52
const compiledProgramFlag = 1 << 14

export function inspectBunExecutable(path: string): {
  format: 'elf' | 'macho' | 'pe'
  payloadOffset: number
  payloadBytes: number
  flags: number
  hasCompiledProgram: boolean
} {
  const bytes = readFileSync(path)
  const magic = bytes.length >= 4 ? bytes.readUInt32LE(0) : 0
  const format =
    magic === 0x464c457f
      ? 'elf'
      : magic === 0xfeedfacf
        ? 'macho'
        : bytes.subarray(0, 2).toString() === 'MZ'
          ? 'pe'
          : undefined
  if (!format) throw new Error('Unsupported executable format')

  let trailerOffset = bytes.lastIndexOf(trailer)
  while (trailerOffset >= offsetsSize + 8) {
    const offsets = trailerOffset - offsetsSize
    const count64 = bytes.readBigUInt64LE(offsets)
    if (count64 <= BigInt(offsets - 8)) {
      const count = Number(count64)
      const payloadOffset = offsets - count
      const payloadBytes = count + offsetsSize + trailer.length
      const modulesOffset = bytes.readUInt32LE(offsets + 8)
      const modulesLength = bytes.readUInt32LE(offsets + 12)
      const entryPoint = bytes.readUInt32LE(offsets + 16)
      const argvOffset = bytes.readUInt32LE(offsets + 20)
      const argvLength = bytes.readUInt32LE(offsets + 24)
      const flags = bytes.readUInt32LE(offsets + 28)
      if (
        bytes.readBigUInt64LE(payloadOffset - 8) === BigInt(payloadBytes) &&
        modulesLength > 0 &&
        modulesLength % moduleRecordSize === 0 &&
        modulesOffset + modulesLength <= count &&
        entryPoint < modulesLength / moduleRecordSize &&
        argvOffset + argvLength <= count &&
        (flags & ~0x7fff) === 0
      ) {
        return {
          format,
          payloadOffset,
          payloadBytes,
          flags,
          hasCompiledProgram: (flags & compiledProgramFlag) !== 0,
        }
      }
    }
    trailerOffset = bytes.lastIndexOf(trailer, trailerOffset - 1)
  }
  throw new Error('No valid pinned Bun standalone module graph found')
}
