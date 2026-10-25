import { test, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'

for (const mode of ['released', 'held', 'multiple-links', 'symlink', 'directory'] as const)
  test(`contended artifact lock observation: ${mode}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./fixtures/artifact-lock-race.ts', import.meta.url)),
        mode,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    const timer = setTimeout(() => child.kill(), 5000)
    try {
      const [status, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(status, err).toBe(0)
      expect(JSON.parse(out)).toMatchObject({ mode, passed: true })
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
    }
  })
