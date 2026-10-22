import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'

async function fixture(run: (path: string, git: (...args: string[]) => string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'bunly-source-identity-'))
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: path, encoding: 'utf8', timeout: 10000 })
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
    return result.stdout.trim()
  }
  try {
    git('init', '-q')
    await writeFile(join(path, 'source.ts'), 'export const version = 1;\n')
    git('add', 'source.ts')
    git(
      '-c',
      'user.name=Bunly fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture'
    )
    await run(path, git)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}
test('clean source records the actual checked-out commit', async () => {
  await fixture(async (path, git) => {
    expect(sourceIdentity(path)).toEqual({
      commit: git('rev-parse', 'HEAD'),
      clean: true,
      reason: 'clean-checkout',
    })
  })
})
test('tracked edits, staged edits and untracked source are not committed evidence', async () => {
  await fixture(async (path, git) => {
    await writeFile(join(path, 'source.ts'), 'export const version = 2;\n')
    expect(sourceIdentity(path).clean).toBe(false)
    git('add', 'source.ts')
    expect(sourceIdentity(path).reason).toBe('dirty-checkout')
  })
  await fixture(async (path) => {
    await writeFile(join(path, 'new-source.ts'), 'export const added = true;\n')
    expect(sourceIdentity(path).reason).toBe('dirty-checkout')
  })
})
test('missing checkout is unavailable, not an environment-derived SHA', async () => {
  const path = await mkdtemp(join(tmpdir(), 'bunly-no-git-'))
  try {
    expect(sourceIdentity(path)).toEqual({ commit: null, clean: false, reason: 'unavailable' })
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})
