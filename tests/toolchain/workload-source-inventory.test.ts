import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { sharedWorkloadSources } from '../../benchmarks/solid/sources.ts'

const required = [
  'benchmarks/solid/ownership.ts',
  'benchmarks/solid/sources.ts',
  'benchmarks/solid/workload.ts',
]

function requireComplete(records: Awaited<ReturnType<typeof sharedWorkloadSources>>): void {
  expect(records.map(({ path }) => path)).toEqual(required)
  expect(new Set(records.map(({ path }) => path)).size).toBe(records.length)
}

test('shared workload provenance binds the ownership oracle and its inventory implementation', async () => {
  const source = resolve(import.meta.dir, '../..')
  const records = await sharedWorkloadSources(source)
  requireComplete(records)
  const imports = new Bun.Transpiler({ loader: 'ts' })
    .scanImports(await readFile(join(source, 'benchmarks/solid/workload.ts'), 'utf8'))
    .filter(({ path }) => path.startsWith('.'))
    .map(({ path }) => posix.join('benchmarks/solid', path))
  expect(imports).toContain('benchmarks/solid/ownership.ts')
  function requireImportedSources(snapshot: typeof records): void {
    for (const path of imports) expect(snapshot.map((record) => record.path)).toContain(path)
  }
  requireImportedSources(records)
  for (const record of records) {
    const bytes = await readFile(join(source, record.path))
    expect(record.bytes).toBe(bytes.byteLength)
    expect(record.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  }
  // The old React manifest's omission cannot pass the same completeness oracle.
  expect(() =>
    requireImportedSources(records.filter(({ path }) => !path.endsWith('/ownership.ts')))
  ).toThrow()
})

test('missing shared inputs fail and changed oracle bytes change the real snapshot', async () => {
  const source = await mkdtemp(join(tmpdir(), 'bun-native-workload-sources-'))
  try {
    for (const path of required) {
      await mkdir(dirname(join(source, path)), { recursive: true })
      await writeFile(join(source, path), `inert source fixture: ${path}\n`)
    }
    const before = await sharedWorkloadSources(source)
    requireComplete(before)
    const oracle = required[0]!
    const old = await readFile(join(source, oracle))
    await writeFile(join(source, oracle), Buffer.concat([old, Buffer.from('changed assertion\n')]))
    const changed = await sharedWorkloadSources(source)
    expect(changed.find(({ path }) => path === oracle)?.sha256).not.toBe(
      before.find(({ path }) => path === oracle)?.sha256
    )
    expect(changed.filter(({ path }) => path !== oracle)).toEqual(
      before.filter(({ path }) => path !== oracle)
    )
    await writeFile(join(source, oracle), old)
    for (const path of required) {
      const bytes = await readFile(join(source, path))
      await rm(join(source, path))
      await expect(sharedWorkloadSources(source)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(join(source, path), bytes)
    }
    expect(await sharedWorkloadSources(source)).toEqual(before)
  } finally {
    await rm(source, { recursive: true, force: true })
  }
})
