import { expect, test } from 'bun:test'
import { watchWindow } from '../../packages/renderer/src/window-lifetime.ts'
import { withApp } from './support.ts'

/** A retained revocation handle must not retain a callback after it is revoked. */
function observe(window: Parameters<typeof watchWindow>[0]) {
  const callback = () => {
    throw new Error('Released listener must never execute')
  }
  return { release: watchWindow(window, callback), reference: new WeakRef(callback) }
}

test('retained window unsubscribe handles release their callbacks immediately', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Revoked callback ownership' })
    const observations = Array.from({ length: 10 }, () => observe(window))
    for (const observation of observations) observation.release()
    await Bun.sleep(0)
    Bun.gc(true)
    await Bun.sleep(0)
    Bun.gc(true)
    expect(observations.map(({ reference }) => reference.deref()).filter(Boolean)).toHaveLength(0)
    // Deliberately retain and exercise every release function after collection.
    for (const observation of observations) observation.release()
    await window.close()
  }))

function activeObservation(window: Parameters<typeof watchWindow>[0], called: number[]) {
  const callback = () => {
    called.push(1)
  }
  return { release: watchWindow(window, callback), reference: new WeakRef(callback) }
}

test('window completion releases callbacks even while unsubscribe handles stay live', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Completed callback ownership' })
    const called: number[] = []
    const observations = Array.from({ length: 10 }, () => activeObservation(window, called))
    await window.close()
    expect(called).toHaveLength(10)
    await Bun.sleep(0)
    Bun.gc(true)
    await Bun.sleep(0)
    Bun.gc(true)
    expect(observations.map(({ reference }) => reference.deref()).filter(Boolean)).toHaveLength(0)
    for (const observation of observations) observation.release()
    expect(called).toHaveLength(10)
  }))
