export const WORKLOAD = Object.freeze({ count: 256, width: 80 })
export function terminalChunk(index: number, width: number = WORKLOAD.width): Uint8Array {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !Number.isInteger(width) ||
    width < 16 ||
    width > 1024
  )
    throw new Error('Invalid fixture dimensions')
  const label = index.toString().padStart(6, '0') + ':'
  return new TextEncoder().encode(
    '\u001b[32m' + label + 'x'.repeat(width - label.length) + '\u001b[0m\r\n'
  )
}
export function fixtureBytes(
  count: number = WORKLOAD.count,
  width: number = WORKLOAD.width
): Uint8Array {
  if (!Number.isInteger(count) || count < 1 || count > 1024)
    throw new Error('Invalid fixture count')
  const chunks = Array.from({ length: count }, (_, index) => terminalChunk(index, width))
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
export function checksum(bytes: Uint8Array, initial = 2166136261): number {
  let result = initial
  for (const byte of bytes) result = Math.imul(result ^ byte, 16777619) >>> 0
  return result
}
