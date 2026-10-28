import assert from 'node:assert/strict'

/** A deliberately crashed renderer must propagate the native failed-shutdown receipt.
 * A clean close or an unrelated transport/timeout error cannot prove this fault.
 */
export async function rendererFaultShutdown(closed: Promise<void>): Promise<true> {
  await assert.rejects(closed, {
    name: 'Error',
    message: 'Native host reported failed shutdown',
  })
  return true
}

/** Pinned Chromium preserves waitpid status on POSIX and GetExitCodeProcess on Windows.
 * This fixed contributor fault accepts neither arbitrary signals nor an unrelated crash.
 */
export function rendererFaultExit(code: unknown, platform: string) {
  if (!['darwin', 'linux', 'win32'].includes(platform))
    throw new Error('Unsupported renderer fault platform')
  const expected = platform === 'win32' ? 86 : 86 << 8
  if (typeof code !== 'number' || !Number.isSafeInteger(code) || code !== expected)
    throw new Error('Wrong native renderer fault exit status')
  return Object.freeze({
    event: 'bunly.native.renderer-failure-observed',
    passed: true,
    exitCode: 86,
    nativeErrorCode: code,
    platform,
  })
}
