import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rename, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DependencyReconciler,
  dependencyStamp,
} from '../packages/cli/src/dev-dependency-reconciler.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const settled = { trackedFiles: 0, scheduled: false, running: false, closed: true }

test('a lost filesystem notification still invalidates a changed build-input baseline once', async () => {
  const events: string[][] = []
  const monitor = new DependencyReconciler({
    maxEntries: 4,
    intervalMs: 10000,
    readStamp: async () => 'new',
    changed: async (paths) => {
      events.push([...paths])
    },
    failed: () => {
      throw new Error('Unexpected failure')
    },
  })
  try {
    const input = new Map([['external.ts', 'old']])
    monitor.replace(input)
    input.set('external.ts', 'new') // caller mutations do not rewrite the captured baseline
    await monitor.scan()
    await monitor.scan()
    expect(events).toEqual([['external.ts']])
    expect(monitor.diagnostics()).toMatchObject({
      trackedFiles: 1,
      scheduled: true,
      running: false,
    })
  } finally {
    await monitor.close()
  }
  expect(monitor.diagnostics()).toEqual(settled)
})

test('reconciliation permits at most eight reads and coalesces overlapping scans', async () => {
  let active = 0,
    peak = 0,
    calls = 0
  const waiting: (() => void)[] = []
  const monitor = new DependencyReconciler({
    maxEntries: 24,
    intervalMs: 10000,
    readStamp: async () => {
      calls++
      peak = Math.max(peak, ++active)
      await new Promise<void>((resolve) => waiting.push(resolve))
      active--
      return 'same'
    },
    changed: async () => {
      throw new Error('Unexpected change')
    },
    failed: () => {},
  })
  monitor.replace(new Map(Array.from({ length: 24 }, (_, i) => [String(i), 'same'])))
  const scan = monitor.scan()
  expect(monitor.scan()).toBe(scan)
  await Promise.resolve()
  expect(active).toBe(8)
  for (let wave = 0; wave < 3; wave++) {
    const current = waiting.splice(0)
    expect(current).toHaveLength(8)
    current.forEach((resolve) => resolve())
    await Bun.sleep(0)
  }
  await scan
  expect({ active, peak, calls }).toEqual({ active: 0, peak: 8, calls: 24 })
  await monitor.close()
  expect(monitor.diagnostics()).toEqual(settled)
})

test('a replaced dependency graph rejects late observations from the previous graph', async () => {
  const pending = deferred<string | null>()
  const changes: string[][] = []
  const monitor = new DependencyReconciler({
    maxEntries: 2,
    intervalMs: 10000,
    readStamp: async (path) => (path === 'old.ts' ? pending.promise : 'same'),
    changed: async (paths) => {
      changes.push([...paths])
    },
    failed: () => {},
  })
  monitor.replace(new Map([['old.ts', 'before']]))
  const scan = monitor.scan()
  await Promise.resolve()
  monitor.replace(new Map([['new.ts', 'same']]))
  pending.resolve('changed')
  await scan
  await monitor.scan()
  expect(changes).toEqual([])
  expect(monitor.diagnostics().trackedFiles).toBe(1)
  await monitor.close()
})

test('close cancels the timer, drains admitted reads and suppresses late invalidations', async () => {
  const pending = deferred<string | null>()
  let changes = 0,
    failures = 0,
    closed = false
  const monitor = new DependencyReconciler({
    maxEntries: 1,
    intervalMs: 10000,
    readStamp: () => pending.promise,
    changed: async () => {
      changes++
    },
    failed: () => {
      failures++
    },
  })
  monitor.replace(new Map([['external.ts', 'old']]))
  const scan = monitor.scan()
  await Promise.resolve()
  const closing = monitor.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  monitor.replace(new Map([['late.ts', 'late']]))
  pending.resolve('new')
  await Promise.all([scan, closing, monitor.close()])
  await monitor.scan()
  expect({ changes, failures, closed }).toEqual({ changes: 0, failures: 0, closed: true })
  expect(monitor.diagnostics()).toEqual(settled)
})

test('a failed read drains other readers and stops the monitor without publishing partial changes', async () => {
  const pending = Array.from({ length: 8 }, () => deferred<string | null>())
  let failures = 0,
    changes = 0
  const monitor = new DependencyReconciler({
    maxEntries: 16,
    intervalMs: 10000,
    readStamp: (path) => pending[Number(path)]!.promise,
    changed: async () => {
      changes++
    },
    failed: () => {
      failures++
      throw new Error('observer')
    },
  })
  monitor.replace(new Map(Array.from({ length: 8 }, (_, i) => [String(i), 'old'])))
  const scan = monitor.scan()
  await Promise.resolve()
  pending[0]!.reject(new Error('read failed'))
  await Bun.sleep(0)
  expect(monitor.diagnostics().running).toBe(true)
  expect(failures).toBe(0)
  pending.slice(1).forEach((item) => item.resolve('new'))
  await scan
  await monitor.scan()
  expect({ failures, changes }).toEqual({ failures: 1, changes: 0 })
  expect(monitor.diagnostics()).toEqual(settled)
  await monitor.close()
})

test('a rejected invalidation fails closed and never becomes an unhandled rejection', async () => {
  let failures = 0
  const monitor = new DependencyReconciler({
    maxEntries: 1,
    intervalMs: 10000,
    readStamp: async () => null,
    changed: async () => {
      throw new Error('capacity')
    },
    failed: () => {
      failures++
    },
  })
  monitor.replace(new Map([['deleted.ts', 'old']]))
  await monitor.scan()
  expect(failures).toBe(1)
  expect(monitor.diagnostics()).toEqual(settled)
  await monitor.close()
})

test('empty graphs do not retain a scheduled scan and bounds reject before replacing the old graph', async () => {
  for (const maxEntries of [0, -1, 16385, NaN, Infinity])
    expect(
      () => new DependencyReconciler({ maxEntries, changed: async () => {}, failed: () => {} })
    ).toThrow(RangeError)
  for (const intervalMs of [0, -1, 10001, NaN, Infinity])
    expect(
      () =>
        new DependencyReconciler({
          maxEntries: 1,
          intervalMs,
          changed: async () => {},
          failed: () => {},
        })
    ).toThrow(RangeError)
  const monitor = new DependencyReconciler({
    maxEntries: 1,
    intervalMs: 10000,
    readStamp: async () => 'same',
    changed: async () => {},
    failed: () => {},
  })
  monitor.replace(new Map([['one.ts', 'same']]))
  expect(() =>
    monitor.replace(
      new Map([
        ['two.ts', null],
        ['three.ts', null],
      ])
    )
  ).toThrow(RangeError)
  expect(monitor.diagnostics().trackedFiles).toBe(1)
  monitor.replace(new Map())
  expect(monitor.diagnostics().scheduled).toBe(false)
  await monitor.close()
})

test('the single timer actually recovers a missed change without an explicit scan', async () => {
  const changed = deferred<readonly string[]>()
  const monitor = new DependencyReconciler({
    maxEntries: 1,
    intervalMs: 2,
    readStamp: async () => 'new',
    changed: async (paths) => {
      changed.resolve(paths)
    },
    failed: () => changed.reject(new Error('failed')),
  })
  monitor.replace(new Map([['external.ts', 'old']]))
  try {
    expect(await changed.promise).toEqual(['external.ts'])
  } finally {
    await monitor.close()
  }
  expect(monitor.diagnostics()).toEqual(settled)
})

test('metadata stamps detect changed timestamps, atomic replacements, missing paths and non-directory parents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-reconcile-'))
  try {
    const file = join(root, 'input.ts'),
      replacement = join(root, 'next.ts')
    expect(await dependencyStamp(file)).toBeNull()
    await writeFile(file, 'export const value = 20')
    // Filesystem timestamp precision is platform-specific. Exercise a deliberate
    // metadata change here; the macOS-only case below retains rapid real writes.
    await utimes(file, 1000000000, 1000000000)
    const before = await dependencyStamp(file)
    await writeFile(file, 'export const value = 21')
    await utimes(file, 1000000010, 1000000010)
    const after = await dependencyStamp(file)
    expect(after).not.toBe(before)
    await writeFile(replacement, 'export const value = 21')
    await rename(replacement, file)
    expect(await dependencyStamp(file)).not.toBe(after)
    expect(await dependencyStamp(join(file, 'child'))).toBeNull()
    await rm(file)
    expect(await dependencyStamp(file)).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== 'darwin')(
  'macOS same-size writes change the dependency metadata baseline',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunly-reconcile-native-'))
    try {
      const file = join(root, 'input.ts')
      await writeFile(file, 'export const value = 20')
      const before = await dependencyStamp(file)
      await writeFile(file, 'export const value = 21')
      expect(await dependencyStamp(file)).not.toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
