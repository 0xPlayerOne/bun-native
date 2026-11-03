/** Failure-only owned-thread observation; never an acceptance or GC workaround. */
import { cc, dlopen, ptr } from 'bun:ffi'
import { fileURLToPath } from 'node:url'

const library = cc({
  source: fileURLToPath(new URL('./retention-stack-probe.c', import.meta.url)),
  symbols: {
    current_frame: { args: [], returns: 'u64' },
    frames: { args: ['u64', 'u64', 'ptr', 'i32'], returns: 'i32' },
    matches: { args: ['u64', 'u64', 'u64', 'ptr', 'i32'], returns: 'i32' },
    clear_dead_stack: { args: ['i32'], returns: 'void' },
  },
})

function limits(): { low: bigint; high: bigint; image: bigint } {
  if (process.platform === 'win32') {
    const kernel = dlopen('kernel32.dll', {
      GetCurrentThreadStackLimits: { args: ['ptr', 'ptr'], returns: 'void' },
      GetModuleHandleW: { args: ['ptr'], returns: 'u64' },
    })
    try {
      const bound = new BigUint64Array(2)
      kernel.symbols.GetCurrentThreadStackLimits(ptr(bound), ptr(bound, 8))
      return {
        low: bound[0]!,
        high: bound[1]!,
        image: BigInt(kernel.symbols.GetModuleHandleW(null)),
      }
    } finally {
      kernel.close()
    }
  }
  if (process.platform === 'darwin') {
    const system = dlopen('/usr/lib/libSystem.B.dylib', {
      pthread_self: { args: [], returns: 'u64' },
      pthread_get_stackaddr_np: { args: ['u64'], returns: 'u64' },
      pthread_get_stacksize_np: { args: ['u64'], returns: 'u64' },
    })
    try {
      const thread = system.symbols.pthread_self()
      const high = BigInt(system.symbols.pthread_get_stackaddr_np(thread))
      return {
        low: high - BigInt(system.symbols.pthread_get_stacksize_np(thread)),
        high,
        image: 0n,
      }
    } finally {
      system.close()
    }
  }
  throw new Error('Unsupported native frame observation target')
}
const hex = (value: bigint) => `0x${value.toString(16)}`

export function clearDeadStackAfterFailure(): void {
  library.symbols.clear_dead_stack(16)
}

export function scanRecordedTarget(address: string) {
  const bounds = limits()
  const words = new BigUint64Array(512)
  const count = library.symbols.frames(bounds.low, bounds.high, ptr(words), 256)
  if (count < 1 || count > 256) throw new Error('No bounded native frame chain')
  const chain = Array.from({ length: count }, (_, index) => ({
    frame: words[index * 2]!,
    returnedTo: words[index * 2 + 1]!,
  }))
  const low = chain[0]!.frame
  const high = chain.at(-1)!.frame + 16n
  if (high - low > 1024n * 1024n) throw new Error('Native frame chain exceeds observation bound')
  const matches = new BigUint64Array(256)
  const found = library.symbols.matches(low, high, BigInt(address), ptr(matches), 128)
  if (found < 0) throw new Error('Invalid native scan bounds')
  return {
    scope:
      'After original assertion failure. Observer-created references may affect inner frames; no root attribution from a match alone.',
    imageBase: hex(bounds.image),
    nativeFrames: chain.map(({ frame, returnedTo }) => ({
      frame: hex(frame),
      returnedTo: hex(returnedTo),
      returnRva: bounds.image && returnedTo >= bounds.image ? hex(returnedTo - bounds.image) : null,
    })),
    exactMatches: found,
    truncated: found > 128,
    words: Array.from({ length: Math.min(found, 128) }, (_, index) => {
      const slot = matches[index * 2]!
      const owner = chain.findIndex(({ frame }) => slot < frame + 16n)
      return {
        slot: hex(slot),
        interiorOffset: Number(matches[index * 2 + 1]! - BigInt(address)),
        frame: owner,
        offsetFromFrame: owner >= 0 ? Number(slot - chain[owner]!.frame) : null,
      }
    }),
  }
}
