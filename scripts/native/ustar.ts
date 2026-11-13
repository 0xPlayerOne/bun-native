/**
 * USTAR header primitives shared by the package-archive reader, the host-archive
 * reader and the host-archive writer. Each reader keeps its own member rules and
 * error messages; scripts/install-bun/archive.mjs keeps its own copy because it
 * must run under Node before Bun exists.
 */

export const USTAR_BLOCK = 512

/** A NUL/space-padded octal field as a safe integer, or undefined when malformed. */
export function ustarNumber(field: Uint8Array): number | undefined {
  const text = Buffer.from(field.buffer, field.byteOffset, field.byteLength).toString('latin1')
  if (!/^[\0 ]*[0-7]+[\0 ]*$/.test(text)) return undefined
  const value = Number.parseInt(text.replaceAll('\0', '').trim(), 8)
  return Number.isSafeInteger(value) ? value : undefined
}

/** The header checksum, counting the checksum field itself as eight spaces. */
export function ustarChecksum(header: Uint8Array): number {
  let sum = 0
  for (let index = 0; index < USTAR_BLOCK; index += 1)
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!
  return sum
}

/** Whether a header's stored checksum field matches its bytes. */
export function ustarChecksumValid(header: Uint8Array): boolean {
  return ustarNumber(header.subarray(148, 156)) === ustarChecksum(header)
}
