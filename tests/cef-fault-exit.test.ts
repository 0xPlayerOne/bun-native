import { test, expect } from 'bun:test'
import { rendererFaultExit, rendererFaultShutdown } from '../examples/cef/fault-exit.ts'

test('renderer fault requires the explicit failed-shutdown rejection', async () => {
  expect(
    await rendererFaultShutdown(Promise.reject(new Error('Native host reported failed shutdown')))
  ).toBe(true)
  await expect(rendererFaultShutdown(Promise.resolve())).rejects.toThrow()
  for (const error of [
    new Error('Native renderer failure did not close the host'),
    new Error('Native control pipe closed unexpectedly'),
    new TypeError('Native host reported failed shutdown'),
    'Native host reported failed shutdown',
  ])
    await expect(rendererFaultShutdown(Promise.reject(error))).rejects.toThrow()
})

test('fixed renderer fault preserves and validates the platform-specific native exit status', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const nativeErrorCode = platform === 'win32' ? 86 : 22016
    expect(rendererFaultExit(nativeErrorCode, platform)).toEqual({
      event: 'bunly.native.renderer-failure-observed',
      passed: true,
      exitCode: 86,
      nativeErrorCode,
      platform,
    })
    for (const code of [
      0,
      -1,
      true,
      '86',
      undefined,
      NaN,
      Infinity,
      9,
      11,
      15,
      85 << 8,
      87 << 8,
      platform === 'win32' ? 22016 : 86,
    ])
      expect(() => rendererFaultExit(code, platform)).toThrow('Wrong native renderer fault')
  }
  expect(() => rendererFaultExit(86, 'unknown')).toThrow('Unsupported')
})
