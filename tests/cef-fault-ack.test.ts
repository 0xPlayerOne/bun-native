import { test, expect } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateGpuInjection, waitForGpuInjection } from '../examples/cef/fault-ack.ts'

const nonce = 'a'.repeat(48)
const receipt = { nonce, mode: 'gpu-exit', role: 'gpu-process', pid: 42, creationTime: 1234.5 }

test('only the matching actual-injection receipt permits GPU recovery testing', () => {
  expect(() => validateGpuInjection(receipt, nonce)).not.toThrow()
  for (const change of [
    { nonce: 'b'.repeat(48) },
    { mode: 'renderer-exit' },
    { role: 'renderer' },
    { pid: 0 },
    { creationTime: 0 },
    { creationTime: NaN },
    { extra: true },
  ])
    expect(() => validateGpuInjection({ ...receipt, ...change }, nonce)).toThrow()
})

test('the recovery fixture waits for receipt creation, not an arbitrary sleep', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-gpu-ack-'))
  const path = join(directory, 'injected.json')
  const writer = (async () => {
    await Bun.sleep(30)
    await writeFile(path, JSON.stringify(receipt))
  })()
  try {
    await waitForGpuInjection(path, nonce, 1000)
    await writer
  } finally {
    await writer.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing receipt has a bounded failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-gpu-ack-'))
  try {
    await expect(waitForGpuInjection(join(directory, 'missing'), nonce, 30)).rejects.toThrow(
      'not acknowledged'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stale nonce and oversized files fail instead of permitting fake recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-gpu-ack-')),
    path = join(directory, 'injected.json')
  try {
    await writeFile(path, JSON.stringify({ ...receipt, nonce: 'b'.repeat(48) }))
    await expect(waitForGpuInjection(path, nonce, 1000)).rejects.toThrow('Mismatched')
    await writeFile(path, 'x'.repeat(1025))
    await expect(waitForGpuInjection(path, nonce, 1000)).rejects.toThrow('receipt file')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('linked receipt files are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-gpu-ack-')),
    target = join(directory, 'target'),
    path = join(directory, 'injected.json')
  try {
    await writeFile(target, JSON.stringify(receipt))
    await symlink(target, path)
    await expect(waitForGpuInjection(path, nonce, 1000)).rejects.toThrow('receipt file')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('invalid wait configuration never starts an unbounded poll', async () => {
  for (const value of [0, -1, 60001, NaN])
    await expect(
      waitForGpuInjection(join(tmpdir(), 'unused-gpu-ack'), nonce, value)
    ).rejects.toThrow('Invalid')
})
