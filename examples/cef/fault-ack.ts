import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** Private test-controller receipt, not a renderer/native authorization protocol. */
export function validateGpuInjection(value: unknown, nonce: string): void {
  if (!/^[a-f0-9]{48}$/.test(nonce) || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid private GPU injection receipt')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'creationTime,mode,nonce,pid,role' ||
    record['nonce'] !== nonce ||
    record['mode'] !== 'gpu-exit' ||
    record['role'] !== 'gpu-process' ||
    !Number.isSafeInteger(record['pid']) ||
    Number(record['pid']) < 1 ||
    typeof record['creationTime'] !== 'number' ||
    !Number.isFinite(record['creationTime']) ||
    record['creationTime'] <= 0
  )
    throw new Error('Mismatched private GPU injection receipt')
}

export async function waitForGpuInjection(
  path: string,
  nonce: string,
  timeoutMs: number
): Promise<void> {
  if (
    !isAbsolute(path) ||
    !/^[a-f0-9]{48}$/.test(nonce) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  )
    throw new Error('Invalid private GPU injection wait')
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024)
        throw new Error('Invalid injection receipt file')
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(1025)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 1024) throw new Error('Oversized injection receipt')
        let value: unknown
        try {
          value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
        if (value !== undefined) {
          validateGpuInjection(value, nonce)
          return
        }
      } finally {
        await handle.close()
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Actual GPU fault injection was not acknowledged before deadline')
}
