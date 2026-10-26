import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
test('profile capture refuses invalid or failed evidence without publishing a capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-profile-reject-'))
  const command = fileURLToPath(
    new URL('../scripts/review-terminal-regression.ts', import.meta.url)
  )
  try {
    for (const [index, input] of [
      null,
      [],
      { schema: 2, passed: false },
      { schema: 2, passed: true, profile: 'claimed' },
      { nativeEvidenceExport: { schema: 999 } },
    ].entries()) {
      const source = join(directory, `${index}.json`),
        output = join(directory, `${index}.capture.json`)
      await writeFile(source, JSON.stringify(input))
      const child = Bun.spawn([process.execPath, command, 'capture', source, output], {
        stdout: 'ignore',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => child.kill(), 5000)
      try {
        const [code] = await Promise.all([child.exited, new Response(child.stderr).text()])
        expect(code).not.toBe(0)
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) {
          child.kill()
          await child.exited
        }
      }
      expect(
        await access(output).then(
          () => true,
          () => false
        )
      ).toBe(false)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
