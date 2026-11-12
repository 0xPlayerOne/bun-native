/**
 * RFC 4122 version 5 (SHA-1) UUIDs, computed independently of GPUI, for the
 * display identity fixtures (#299). GPUI names a Windows display by
 * v5(DNS, its GDI device name) and a Wayland output by v5(DNS, its
 * `wl_output.name`).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

function uuidV5(namespace: string, name: Uint8Array): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name)
    .digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * GPUI's Windows display UUID is v5(DNS, big-endian UTF-16 bytes of the whole
 * 32-unit `szDevice` buffer from GetMonitorInfoW, NUL padding included). It
 * therefore names a GDI device such as `\\.\DISPLAY1`, not a physical monitor.
 */
export function windowsDeviceUuid(deviceName: string): string {
  assert(deviceName.length < 32, 'GDI device names fit in szDevice')
  const bytes = new Uint8Array(64)
  for (let index = 0; index < deviceName.length; index++) {
    const unit = deviceName.charCodeAt(index)
    bytes[index * 2] = unit >> 8
    bytes[index * 2 + 1] = unit & 0xff
  }
  return uuidV5(DNS_NAMESPACE, bytes)
}

/**
 * GPUI's Wayland display UUID is v5(DNS, the UTF-8 `wl_output.name`), the
 * compositor's connector name such as `DP-1` or `HEADLESS-1` (wl_output v4).
 * It names a connector, not a physical monitor.
 */
export function waylandOutputUuid(outputName: string): string {
  return uuidV5(DNS_NAMESPACE, new TextEncoder().encode(outputName))
}
