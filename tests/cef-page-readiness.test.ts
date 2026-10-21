import { expect, test } from 'bun:test'
import { packagedPageReadiness, pageTimeout } from '../examples/cef/page-readiness.ts'
import type { NativeEvent } from '../packages/runtime/src/native-transport.ts'

function fixture() {
  let listener: ((event: NativeEvent) => void) | undefined
  let callback: (() => void) | undefined
  let registrations = 0
  let removals = 0
  const page = packagedPageReadiness(
    (next) => {
      listener = next
      return () => {
        removals++
        listener = undefined
      }
    },
    10000,
    {
      set(next) {
        callback = next
        registrations++
        return 1
      },
      clear() {
        callback = undefined
      },
    }
  )
  return {
    page,
    emit(message: string) {
      listener?.({ v: 1, event: 'view.console', data: { message } })
    },
    expire() {
      callback?.()
    },
    state() {
      return { registrations, removals, scheduled: callback !== undefined }
    },
  }
}
test('session/window creation does not consume the page-load deadline', async () => {
  const f = fixture()
  expect(f.state()).toEqual({ registrations: 0, removals: 0, scheduled: false })
  f.expire()
  const first = f.page.wait()
  expect(f.page.wait()).toBe(first)
  expect(f.state().registrations).toBe(1)
  f.emit('BUNLY_ASSET_TEST_OK')
  await first
  expect(f.state()).toEqual({ registrations: 1, removals: 1, scheduled: false })
})
test('completion during native view creation is retained before wait', async () => {
  const f = fixture()
  f.emit('BUNLY_ASSET_TEST_OK')
  await f.page.wait()
  expect(f.state().registrations).toBe(0)
  expect(f.state().removals).toBe(1)
})
test('real page failure is not hidden by a later success or cancellation', async () => {
  const f = fixture()
  f.emit('BUNLY_ASSET_TEST_FAILED response mismatch')
  f.emit('BUNLY_ASSET_TEST_OK')
  f.page.close()
  await expect(f.page.wait()).rejects.toThrow('response mismatch')
})
test('missing completion still has a bounded deadline and removes its listener', async () => {
  const f = fixture()
  const waiting = f.page.wait()
  f.emit('unrelated native log')
  f.expire()
  await expect(waiting).rejects.toThrow('Packaged module did not complete')
  expect(f.state().removals).toBe(1)
})
test('creation failure cancels the preinstalled listener without starting a timer', async () => {
  const f = fixture()
  f.page.close()
  f.page.close()
  await expect(f.page.wait()).rejects.toThrow('cancelled')
  expect(f.state()).toEqual({ registrations: 0, removals: 1, scheduled: false })
})
test('synchronous delivery and invalid timing inputs retain cleanup guarantees', async () => {
  let removed = 0
  const page = packagedPageReadiness((listener) => {
    listener({ v: 1, event: 'view.console', data: { message: 'BUNLY_ASSET_TEST_OK' } })
    return () => {
      removed++
    }
  })
  await page.wait()
  expect(removed).toBe(1)
  for (const value of [0, -1, 0.5, NaN, Infinity, 60001])
    expect(() => packagedPageReadiness(() => () => {}, value)).toThrow('deadline')
})

test('slow-guest fixture timing is explicit and bounded, with unchanged defaults', () => {
  expect(pageTimeout(undefined)).toBe(10000)
  expect(pageTimeout('60000')).toBe(60000)
  for (const value of ['', '0', '060000', '60001', 'Infinity', 'NaN', '1.5', ' 10000'])
    expect(() => pageTimeout(value)).toThrow('deadline')
})
