import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createProject } from '../../scripts/native/project.ts'

const repository = resolve(import.meta.dir, '../..')
const setting = 'MIMALLOC_PURGE_DELAY=0 '

function verbose(args: string[], cwd: string) {
  const env: Record<string, string | undefined> = { ...process.env, MIMALLOC_VERBOSE: '1' }
  delete env['MIMALLOC_PURGE_DELAY']
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  })
  expect(result.signalCode ?? null).toBeNull()
  return {
    code: result.exitCode,
    // One line per Bun process: the `bun run` launcher, then the script's CLI process.
    purge: [
      ...(result.stdout.toString() + result.stderr.toString()).matchAll(
        /option 'purge_delay': (-?\d+)/g
      ),
    ].map((match) => Number(match[1])),
  }
}

describe('persistent CLI controller allocator policy', () => {
  test('checkout dev scripts start the CLI with immediate allocator purge', async () => {
    const root = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
    expect(root.scripts.native).toBe(`${setting}bun scripts/native.ts`)
    const cache = join(repository, '.bun-native')
    mkdirSync(cache, { recursive: true })
    const directory = mkdtempSync(join(cache, 'allocator-test-'))
    try {
      const project = await createProject(repository, join(directory, 'app'), 'react', 'typescript')
      const scripts = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).scripts
      expect(scripts.dev).toStartWith(`${setting}bun `)
      // Only the long-lived development controller changes allocator policy.
      expect(scripts.build).not.toContain('MIMALLOC')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
    // tests/tooling/package-set.test.ts checks the generated standalone dev script.
  })

  // MIMALLOC_VERBOSE option reporting is verified on the pinned Linux runtime only.
  test.if(process.platform === 'linux')(
    'the pinned Bun applies the setting to the actual CLI process, not its launcher',
    async () => {
      expect(verbose(['-e', '0'], repository)).toEqual({ code: 0, purge: [100] })
      expect(verbose(['run', 'native', '--help'], repository)).toEqual({ code: 0, purge: [100, 0] })
      const cache = join(repository, '.bun-native')
      mkdirSync(cache, { recursive: true })
      const directory = mkdtempSync(join(cache, 'allocator-test-'))
      try {
        const project = await createProject(
          repository,
          join(directory, 'app'),
          'solid',
          'typescript'
        )
        // No host is supplied, so the CLI fails after startup without bundling.
        const result = verbose(['run', 'dev'], project)
        expect(result.code).not.toBe(0)
        expect(result.purge).toEqual([100, 0])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
