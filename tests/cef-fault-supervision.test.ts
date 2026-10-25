import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rename, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  spawnFaultShell,
  validateTreeObservation,
  waitForTreeObservation,
} from '../examples/cef/fault-supervision.ts'
const nonce = 'a'.repeat(48)
const pids = [101, 102]
const receipt = { mode: 'backend-shell-tree-exit', nonce, pids }

test('tree observation binds exact mode, nonce and ordered owned process identities', () => {
  validateTreeObservation(receipt, nonce, pids)
  for (const value of [
    null,
    {},
    [],
    { ...receipt, mode: 'gpu-exit' },
    { ...receipt, nonce: 'b'.repeat(48) },
    { ...receipt, pids: [102, 101] },
    { ...receipt, pids: [101, 101] },
    { ...receipt, extra: true },
  ])
    expect(() => validateTreeObservation(value, nonce, pids)).toThrow()
  expect(() => validateTreeObservation(receipt, nonce, [101, 101])).toThrow()
  expect(() => validateTreeObservation(receipt, 'not-a-nonce', pids)).toThrow()
})

test('tree readiness handles existing and atomically published receipts after explicit notification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-tree-receipt-'))
  const path = join(root, 'receipt.json')
  try {
    let notify!: () => void
    const notified = new Promise<void>((resolve) => {
      notify = resolve
    })
    const waiter = waitForTreeObservation(path, nonce, pids, 1000, () => notified)
    await writeFile(join(root, 'pending'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
    await rename(join(root, 'pending'), path)
    notify()
    await waiter
    await waitForTreeObservation(path, nonce, pids, 1000, async () => {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('malformed, oversized and unsafe tree receipts never become readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-tree-receipt-'))
  const path = join(root, 'receipt.json')
  try {
    for (const text of ['{', JSON.stringify({ ...receipt, pids: [999, 102] }), ' '.repeat(1025)]) {
      await writeFile(path, text, { mode: 0o600 })
      await expect(
        waitForTreeObservation(path, nonce, pids, 1000, async () => {})
      ).rejects.toThrow()
    }
    await rm(path)
    await mkdir(path)
    await expect(waitForTreeObservation(path, nonce, pids, 1000, async () => {})).rejects.toThrow(
      'Unsafe'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('absent tree notification expires and aborts its one owned request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-tree-receipt-'))
  try {
    let signal: AbortSignal | undefined
    await expect(
      waitForTreeObservation(join(root, 'absent'), nonce, pids, 10, (owned) => {
        signal = owned
        return new Promise<void>(() => {})
      })
    ).rejects.toThrow('deadline')
    expect(signal?.aborted).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Actual cmd.exe argument parsing, not a simulated quoting assertion. The full
// native qualifier additionally uses a packaged Bun path with Unicode and spaces.
test.skipIf(process.platform !== 'win32')(
  'Windows owned shell starts an entry with spaces and Unicode',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunly shell é Ω '))
    const entry = join(root, 'child with spaces é.ts')
    let child: ReturnType<typeof spawnFaultShell> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await writeFile(
        entry,
        'console.log(JSON.stringify({parent:process.ppid, nonce:process.env.BUNLY_CEF_FAULT_NONCE}))\n'
      )
      child = spawnFaultShell(entry, nonce)
      timer = setTimeout(() => child?.kill('SIGKILL'), 5000)
      const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
      expect(exit).toBe(0)
      expect(JSON.parse(output.trim())).toEqual({ parent: child.pid, nonce })
    } finally {
      clearTimeout(timer)
      if (child && child.exitCode === null) {
        child.kill('SIGKILL')
        await child.exited
      }
      await rm(root, { recursive: true, force: true })
    }
  }
)
