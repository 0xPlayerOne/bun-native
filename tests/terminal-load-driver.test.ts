import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('load entrypoint selects the real native owner and cannot report guarded success through a direct driver', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bunly-load-driver-'))
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, 'fixtures/terminal-load-native-selection.ts'),
      join(dir, 'receipt.jsonl'),
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const deadline = setTimeout(() => child.kill(), 5000)
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, err).toBe(0)
    expect(out.trim()).toBe('native-owner-selection-required-before-fixture-admission')
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    await rm(dir, { recursive: true, force: true })
  }
})
