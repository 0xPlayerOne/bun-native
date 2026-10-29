import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { prepareDevelopmentHost } from '../packages/cli/src/dev-cache.ts'

async function fixture(root: string) {
  const source = 'native-host-v1'
  const input = join(root, 'native')
  await fs.writeFile(input, source)
  let assemblies = 0
  const options = {
    cacheRoot: join(root, 'cache'),
    identity: {
      appId: 'test.app',
      nativeAbi: '1',
      engineVersion: 'cef:156.0.7',
      target: `${process.platform}-${process.arch}`,
      bunVersion: Bun.version,
      configuration: '{}',
      inputs: [
        {
          name: 'native-host',
          path: input,
          sha256: createHash('sha256').update(source).digest('hex'),
        },
      ],
    },
    assemble: async (directory: string) => {
      assemblies++
      await fs.writeFile(join(directory, 'host.js'), 'complete')
      return { entrypoint: 'host.js' }
    },
  }
  return { options, prepared: await prepareDevelopmentHost(options), assemblies: () => assemblies }
}

test('publication after an absent-directory observation is reused instead of reported as corruption', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'bunly-cache-publication-'))
  try {
    const { options, prepared, assemblies } = await fixture(root)
    const staged = join(root, 'ready-to-publish')
    await fs.rename(prepared.directory, staged)
    const inspect = fs.lstat
    let observations = 0
    const publishAfterMiss = (...args: Parameters<typeof inspect>) => {
      if (args[0] === prepared.directory && observations++ === 0) {
        return inspect(...args).catch(async (error: NodeJS.ErrnoException) => {
          expect(error.code).toBe('ENOENT')
          // Complete another publisher's atomic rename before the waiting
          // reader receives the real absent-directory result. No timer race.
          await fs.rename(staged, prepared.directory)
          throw error
        })
      }
      return inspect(...args)
    }
    // Forward the original argument/result pairs for every lstat overload.
    const stat = spyOn(fs, 'lstat').mockImplementation(publishAfterMiss as typeof inspect)
    try {
      const result = await prepareDevelopmentHost(options)
      expect(result.cacheHit).toBe(true)
      expect(result.directory).toBe(prepared.directory)
      expect(await fs.readFile(result.entrypoint, 'utf8')).toBe('complete')
      expect(assemblies()).toBe(1)
      expect(observations).toBeGreaterThanOrEqual(2)
      expect(await fs.readdir(options.cacheRoot)).toEqual([prepared.key])
    } finally {
      stat.mockRestore()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('an existing published directory with no receipt remains an integrity failure', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'bunly-cache-receipt-'))
  try {
    const { options, prepared, assemblies } = await fixture(root)
    await fs.rm(join(prepared.directory, 'bunly-dev-host.json'))
    await expect(prepareDevelopmentHost(options)).rejects.toMatchObject({ code: 'CACHE_INTEGRITY' })
    expect(assemblies()).toBe(1)
    expect(await fs.readFile(prepared.entrypoint, 'utf8')).toBe('complete')
    expect(await fs.readdir(options.cacheRoot)).toEqual([prepared.key])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('stage cleanup failure retains the assembly error and still releases the owned lock', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'bunly-cache-cleanup-'))
  try {
    const { options, prepared } = await fixture(root)
    await fs.rm(prepared.directory, { recursive: true })
    const primary = new Error('assembly failed')
    const cleanup = new Error('stage cleanup failed')
    const remove = fs.rm
    const spy = spyOn(fs, 'rm').mockImplementation((async (path, options) => {
      if (typeof path === 'string' && basename(path).startsWith('.stage-')) throw cleanup
      return remove(path, options)
    }) as typeof fs.rm)
    try {
      const failure = await prepareDevelopmentHost({
        ...options,
        assemble: async () => {
          throw primary
        },
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([primary, cleanup])
      expect(await fs.readdir(options.cacheRoot)).not.toContain(`${prepared.key}.lock`)
    } finally {
      spy.mockRestore()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('both cleanup failures are reported with the original failure', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'bunly-cache-cleanup-both-'))
  try {
    const { options, prepared } = await fixture(root)
    await fs.rm(prepared.directory, { recursive: true })
    const primary = new Error('assembly failed')
    const stageFailure = new Error('stage cleanup failed')
    const lockFailure = new Error('lock cleanup failed')
    const remove = fs.rm
    const attempts: string[] = []
    const spy = spyOn(fs, 'rm').mockImplementation((async (path, opts) => {
      if (typeof path === 'string' && basename(path).startsWith('.stage-')) {
        attempts.push('stage')
        throw stageFailure
      }
      if (typeof path === 'string' && path === `${prepared.directory}.lock`) {
        attempts.push('lock')
        throw lockFailure
      }
      return remove(path, opts)
    }) as typeof fs.rm)
    try {
      const failure = await prepareDevelopmentHost({
        ...options,
        assemble: async () => {
          throw primary
        },
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([primary, stageFailure, lockFailure])
      expect(attempts).toEqual(['stage', 'lock'])
      expect(await fs.readdir(options.cacheRoot)).toContain(`${prepared.key}.lock`)
    } finally {
      spy.mockRestore()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a cleanup failure after publication is reported and the published cache remains verifiable', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'bunly-cache-cleanup-published-'))
  try {
    const { options, prepared } = await fixture(root)
    await fs.rm(prepared.directory, { recursive: true })
    const cleanup = new Error('stage cleanup failed')
    const remove = fs.rm
    const spy = spyOn(fs, 'rm').mockImplementation((async (path, opts) => {
      if (typeof path === 'string' && basename(path).startsWith('.stage-')) throw cleanup
      return remove(path, opts)
    }) as typeof fs.rm)
    try {
      const failure = await prepareDevelopmentHost(options).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([cleanup])
      expect(await fs.readdir(options.cacheRoot)).not.toContain(`${prepared.key}.lock`)
    } finally {
      spy.mockRestore()
    }
    const recovered = await prepareDevelopmentHost(options)
    expect(recovered.cacheHit).toBe(true)
    expect(await fs.readFile(recovered.entrypoint, 'utf8')).toBe('complete')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
