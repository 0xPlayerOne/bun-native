import { expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectFingerprint, rescanInput } from '../../scripts/native/inputs.ts'

async function fixture(exercise: (path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-inputs-'))
  try {
    await exercise(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('unknown and directory notifications request a scan; excluded paths do not', () => {
  for (const path of [undefined, null, 'src', 'README.md', Buffer.from('src/main.ts')])
    expect(rescanInput(path)).toBe(true)
  for (const path of ['dist/ignored.ts', 'a\\node_modules\\x.js', '.git', 'build/x.json'])
    expect(rescanInput(path)).toBe(false)
})

test('fingerprints track relevant bytes and paths, while ignored changes leave them unchanged', async () => {
  await fixture(async (path) => {
    const empty = await projectFingerprint(path)
    mkdirSync(join(path, 'src'))
    const source = join(path, 'src/main.ts')
    writeFileSync(source, 'export const value = 1\n')
    const first = await projectFingerprint(path)
    expect(first).not.toBe(empty)
    writeFileSync(source, 'export const value = 1\n')
    for (const name of ['node_modules', '.git', '.bun-native', 'dist', 'build']) {
      mkdirSync(join(path, name))
      writeFileSync(join(path, name, 'ignored.ts'), 'not valid source <\n')
    }
    writeFileSync(join(path, 'README.md'), 'Ignored documentation\n')
    expect(await projectFingerprint(path)).toBe(first)
    writeFileSync(source, 'export const value = 2\n')
    const changed = await projectFingerprint(path)
    expect(changed).not.toBe(first)
    renameSync(join(path, 'src'), join(path, 'renamed'))
    expect(await projectFingerprint(path)).not.toBe(changed)
    rmSync(join(path, 'renamed'), { recursive: true })
    expect(await projectFingerprint(path)).toBe(empty)
    writeFileSync(join(path, 'settings.json'), '{"value":1}\n')
    expect(await projectFingerprint(path)).not.toBe(empty)
  })
})

test.skipIf(process.platform === 'win32')(
  'file links include resolved target identity and bytes; directory links are not traversed',
  async () => {
    await fixture(async (path) => {
      const empty = await projectFingerprint(path)
      writeFileSync(join(path, 'first.data'), 'export const value = 1\n')
      writeFileSync(join(path, 'second.data'), 'export const value = 1\n')
      symlinkSync(path, join(path, 'cycle.ts'), 'dir')
      symlinkSync(join(path, 'absent'), join(path, 'broken.ts'), 'file')
      expect(await projectFingerprint(path)).toBe(empty)
      const link = join(path, 'linked.ts')
      symlinkSync(join(path, 'first.data'), link, 'file')
      const first = await projectFingerprint(path)
      writeFileSync(join(path, 'first.data'), 'export const value = 2\n')
      expect(await projectFingerprint(path)).not.toBe(first)
      writeFileSync(join(path, 'first.data'), 'export const value = 1\n')
      rmSync(link)
      symlinkSync(join(path, 'second.data'), link, 'file')
      expect(await projectFingerprint(path)).not.toBe(first)
    })
  }
)

test('a file removed after enumeration is absent; later recreation has a new fingerprint', async () => {
  await fixture(async (path) => {
    const empty = await projectFingerprint(path)
    const source = join(path, 'main.ts')
    writeFileSync(source, 'export const value = 1\n')
    const file = Bun.file
    const observed = spyOn(Bun, 'file').mockImplementation(((filename: string) => {
      if (filename === source) rmSync(source)
      return file(filename)
    }) as typeof Bun.file)
    try {
      expect(await projectFingerprint(path)).toBe(empty)
    } finally {
      observed.mockRestore()
    }
    writeFileSync(source, 'export const value = 2\n')
    expect(await projectFingerprint(path)).not.toBe(empty)
  })
})

test('a vanished directory is absent, while unrelated IO failures propagate', async () => {
  await fixture(async (path) => {
    const empty = await projectFingerprint(path)
    const source = join(path, 'src')
    mkdirSync(source)
    writeFileSync(join(source, 'main.ts'), 'export const value = 1\n')
    const read = promises.readdir
    const observed = spyOn(promises, 'readdir').mockImplementation((...args: unknown[]) => {
      if (args[0] === source) rmSync(source, { recursive: true })
      return Reflect.apply(read, promises, args)
    })
    try {
      expect(await projectFingerprint(path)).toBe(empty)
      observed.mockImplementation(() => {
        throw new Error('scan read failed')
      })
      await expect(projectFingerprint(path)).rejects.toThrow('scan read failed')
    } finally {
      observed.mockRestore()
    }
  })
})

test('cancelling during the concurrent reads rejects the snapshot', async () => {
  await fixture(async (path) => {
    for (const name of ['a.ts', 'b.ts', 'c.ts'])
      writeFileSync(join(path, name), Buffer.alloc(256 * 1024, 'a'))
    const controller = new AbortController()
    const file = Bun.file
    let reads = 0
    const observed = spyOn(Bun, 'file').mockImplementation(((filename: string) => {
      reads += 1
      controller.abort()
      return file(filename)
    }) as typeof Bun.file)
    try {
      await expect(projectFingerprint(path, controller.signal)).rejects.toThrow()
      expect(reads).toBeGreaterThan(0)
      reads = 0
      // An already cancelled scan reads nothing.
      await expect(projectFingerprint(path, controller.signal)).rejects.toThrow()
      expect(reads).toBe(0)
    } finally {
      observed.mockRestore()
    }
  })
})
