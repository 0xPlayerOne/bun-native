/** Acquisition-only OS locks, released by the kernel on process death. No stale-PID lock theft. */
import { open, lstat, type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { cefError } from './cef-manifest.ts'

export async function kernelLock(
  path: string,
  signal: AbortSignal,
  shared = false
): Promise<() => Promise<void>> {
  const { dlopen, FFIType, ptr } = await import('bun:ffi')
  const before = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
    return undefined
  })
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
    cefError('UNSAFE_CACHE', 'Runtime lock is not a private regular file')
  if (process.platform === 'win32') {
    const lib = dlopen('kernel32.dll', {
      CreateFileW: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.u64,
        ],
        returns: FFIType.u64,
      },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    })
    const name = Buffer.from(path + '\0', 'utf16le')
    try {
      for (;;) {
        signal.throwIfAborted()
        const handle = BigInt(
          lib.symbols.CreateFileW(
            ptr(name),
            shared ? 0x80000000 : 0xc0000000,
            shared ? 1 : 0,
            null,
            shared ? 3 : 4,
            0x00200080,
            0n
          )
        )
        if (handle !== 0xffffffffffffffffn && handle !== 0n) {
          let released = false
          return async () => {
            if (!released) {
              released = true
              const ok = lib.symbols.CloseHandle(handle)
              lib.close()
              if (!ok) cefError('LOCK_FAILED', 'Unable to release native runtime lock')
            }
          }
        }
        const error = lib.symbols.GetLastError()
        if (error !== 32 && error !== 33)
          cefError('LOCK_FAILED', `Native runtime lock failed (${error})`)
        await delay(25, undefined, { signal })
      }
    } catch (e) {
      lib.close()
      throw e
    }
  }
  if (!['darwin', 'linux'].includes(process.platform))
    cefError('UNSUPPORTED_TARGET', 'No qualified native lock provider')
  const lib = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  })
  let file: FileHandle | undefined
  try {
    file = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1) cefError('UNSAFE_CACHE', 'Unsafe native lock file')
    while (lib.symbols.flock(file.fd, shared ? 5 : 6) !== 0) {
      signal.throwIfAborted()
      await delay(25, undefined, { signal })
    }
    signal.throwIfAborted()
    const owned = file
    let released = false
    return async () => {
      if (!released) {
        released = true
        try {
          if (lib.symbols.flock(owned.fd, 8) !== 0)
            cefError('LOCK_FAILED', 'Unable to release runtime lock')
        } finally {
          await owned.close()
          lib.close()
        }
      }
    }
  } catch (e) {
    await file?.close()
    lib.close()
    throw e
  }
}
