import { test, expect } from 'bun:test'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { capture } from './fixtures/terminal-review-capture.ts'

const command = fileURLToPath(new URL('../scripts/review-terminal-regression.ts', import.meta.url))
const pinnedRuntimeTest = test.skipIf(Bun.version !== '1.4.4')
async function run(args: string[]): Promise<number | null> {
  const child = Bun.spawn([process.execPath, command, ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 5000)
  try {
    const [code] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return code
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

pinnedRuntimeTest(
  'profile review CLI distinguishes adverse shifts, invalid input and descriptive overlap',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bunly-review-command-'))
    try {
      const baseline = join(directory, 'baseline.json'),
        candidate = join(directory, 'candidate.json')
      await writeFile(baseline, JSON.stringify(capture()))
      await writeFile(candidate, JSON.stringify(capture(30)))
      const adverse = join(directory, 'adverse.json')
      expect(await run(['compare', baseline, candidate, adverse])).toBe(2)
      const review = JSON.parse(await readFile(adverse, 'utf8'))
      expect(review.reviewRequired).toBe(true)
      expect(review.releaseApproved).toBe(false)
      const same = join(directory, 'overlap.json')
      expect(await run(['compare', baseline, baseline, same])).toBe(0)
      expect(JSON.parse(await readFile(same, 'utf8')).reviewRequired).toBe(false)
      const malformed = join(directory, 'malformed.json')
      await writeFile(candidate, JSON.stringify({ schema: 1, passed: true }))
      expect(await run(['compare', baseline, candidate, malformed])).toBe(1)
      expect(await exists(malformed)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)

pinnedRuntimeTest(
  'profile review CLI refuses trailing arguments and never overwrites an existing report',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bunly-review-exclusive-'))
    try {
      const baseline = join(directory, 'baseline.json'),
        output = join(directory, 'report.json')
      await writeFile(baseline, JSON.stringify(capture()))
      expect(await run(['envelope', baseline, output, 'unexpected'])).toBe(1)
      expect(await exists(output)).toBe(false)
      expect(await run(['compare', baseline, baseline, output, 'unexpected'])).toBe(1)
      expect(await exists(output)).toBe(false)
      await writeFile(output, 'preserved-report\n')
      expect(await run(['envelope', baseline, output])).toBe(1)
      expect(await readFile(output, 'utf8')).toBe('preserved-report\n')
      const envelope = join(directory, 'envelope.json')
      expect(await run(['envelope', baseline, envelope])).toBe(0)
      expect(JSON.parse(await readFile(envelope, 'utf8')).launchesPerMode).toBe(5)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)
