import { dlopen, ptr } from 'bun:ffi'
import { isAbsolute } from 'node:path'

export function scanWindowsUnwind(address: string) {
  const path = process.env['BUN_NATIVE_RETENTION_UNWIND_DLL']
  if (process.platform !== 'win32' || !path || !isAbsolute(path))
    throw new Error('An explicit Windows research unwind helper is required')
  const helper = dlopen(path, {
    observe: { args: ['u64', 'ptr', 'i32'], returns: 'i32' },
  })
  try {
    const words = new BigUint64Array(8 + 128 * 7 + 128 * 3)
    const result = helper.symbols.observe(BigInt(address), ptr(words), words.length)
    if (result !== 0) throw new Error(`Bounded native unwind failed (${result})`)
    const frameCount = Number(words[3])
    const matchCount = Number(words[4])
    if (frameCount > 128 || frameCount < 1) throw new Error('Invalid native unwind count')
    const hex = (value: bigint) => `0x${value.toString(16)}`
    const frames = Array.from({ length: frameCount }, (_, index) => {
      const offset = 8 + index * 7
      return {
        instruction: hex(words[offset]!),
        stack: hex(words[offset + 1]!),
        image: hex(words[offset + 2]!),
        functionBegin: hex(words[offset + 3]!),
        functionEnd: hex(words[offset + 4]!),
        unwindData: hex(words[offset + 5]!),
        establisher: hex(words[offset + 6]!),
      }
    })
    return {
      scope:
        'After-failure whole live current stack; Windows x64 virtual unwind. Inner frames include observer effects.',
      lowest: hex(words[0]!),
      highest: hex(words[1]!),
      applicationImageBase: hex(words[2]!),
      walkedToRoot: words[7] === 1n,
      frames,
      exactMatches: matchCount,
      matchesTruncated: matchCount > 128,
      matches: Array.from({ length: Math.min(matchCount, 128) }, (_, index) => {
        const offset = 8 + 128 * 7 + index * 3
        const owner = Number(BigInt.asIntN(64, words[offset + 2]!))
        return {
          address: hex(words[offset]!),
          interiorOffset: Number(words[offset + 1]),
          frame: owner,
          fromFrameStack: owner >= 0 ? Number(words[offset]! - words[8 + owner * 7 + 1]!) : null,
        }
      }),
    }
  } finally {
    helper.close()
  }
}
