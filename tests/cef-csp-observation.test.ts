import { expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { observePolicyViolations } = (await import(
  pathToFileURL(resolve(import.meta.dir, '../examples/cef/public/nested/policy-violations.mjs'))
    .href
)) as {
  observePolicyViolations(
    target: EventTarget,
    timeoutMs?: number
  ): { completion: Promise<void>; dispose(): void }
}
class Target extends EventTarget {
  listeners = 0
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    super.addEventListener(type, listener, options)
    this.listeners++
  }
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    super.removeEventListener(type, listener, options)
    this.listeners--
  }
}
function violation(
  target: EventTarget,
  directive: string,
  blockedURI = 'https://blocked.invalid/'
) {
  const event = new Event('securitypolicyviolation')
  Object.defineProperties(event, {
    effectiveDirective: { value: directive },
    blockedURI: { value: blockedURI },
  })
  target.dispatchEvent(event)
}
test('actual public CSP helper requires both directives, without a 100ms acceptance timer', async () => {
  const target = new Target(),
    probe = observePolicyViolations(target, 1000)
  violation(target, 'connect-src')
  let completed = false
  void probe.completion.then(() => {
    completed = true
  })
  await Bun.sleep(150)
  expect(completed).toBe(false)
  violation(target, 'frame-src')
  await probe.completion
  expect(target.listeners).toBe(0)
  probe.dispose()
  expect(target.listeners).toBe(0)
})
test('unrelated and duplicate violation events cannot satisfy the intended origin and directives', async () => {
  const target = new Target(),
    probe = observePolicyViolations(target, 15)
  violation(target, 'connect-src')
  violation(target, 'connect-src')
  violation(target, 'frame-src', 'https://unrelated.invalid/')
  violation(target, 'script-src')
  await expect(probe.completion).rejects.toThrow('frame-src')
  expect(target.listeners).toBe(0)
})
test('missing evidence and disposed probes fail instead of manufacturing a security pass', async () => {
  const target = new Target(),
    probe = observePolicyViolations(target, 1000)
  probe.dispose()
  await expect(probe.completion).rejects.toThrow('disposed')
  expect(target.listeners).toBe(0)
})
test('policy observation cannot request infinite or unbounded waits', () => {
  for (const ms of [0, -1, 60001, Infinity, NaN, 1.5])
    expect(() => observePolicyViolations(new EventTarget(), ms)).toThrow('deadline')
})
