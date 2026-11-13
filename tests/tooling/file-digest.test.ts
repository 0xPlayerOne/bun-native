import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedFileDigest, fileDigest, sha256 } from '../../scripts/native/artifact.ts'

const directory = await mkdtemp(join(tmpdir(), 'bun-native-file-digest-'))
afterAll(() => rm(directory, { recursive: true, force: true }))

// Whole-file reads cover sources; larger files take the chunked path. Both must
// report exactly the bytes and SHA-256 of the content, across the 4 MiB switch.
test.each([0, 1, 65_537, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, 5 * 1024 * 1024 + 12_345])(
  'digests %i bytes exactly',
  async (size) => {
    const content = Buffer.alloc(size)
    for (let index = 0; index < size; index += 1) content[index] = (index * 31 + 7) & 0xff
    const path = join(directory, `content-${size}`)
    await writeFile(path, content)
    expect(await fileDigest(path)).toEqual({
      bytes: size,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
  }
)

test('missing files and directories fail with their filesystem codes', async () => {
  await expect(fileDigest(join(directory, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fileDigest(directory)).rejects.toMatchObject({ code: 'EISDIR' })
})

test('sha256 matches node:crypto for text and bytes', () => {
  for (const value of ['', 'text', new Uint8Array([0, 1, 255])])
    expect(sha256(value)).toBe(createHash('sha256').update(value).digest('hex'))
})

test('a cached digest is reused only while the file keeps its identity', async () => {
  const path = join(directory, 'compiler')
  const cache = join(directory, 'cache', 'compiler-digest.json')
  await writeFile(path, 'first compiler')
  const first = await cachedFileDigest(path, cache)
  expect(first).toEqual(await fileDigest(path))
  // A hit returns the cached digest without hashing: prove it with a marked cache.
  const stored = JSON.parse(await readFile(cache, 'utf8'))
  await writeFile(
    cache,
    JSON.stringify({ ...stored, digest: { bytes: 1, sha256: 'a'.repeat(64) } })
  )
  expect(await cachedFileDigest(path, cache)).toEqual({ bytes: 1, sha256: 'a'.repeat(64) })
  // Any write changes the identity, so the file is hashed again and the cache refreshed.
  await writeFile(path, 'second compiler!')
  expect(await cachedFileDigest(path, cache)).toEqual(await fileDigest(path))
  // A corrupt cache or one for another path is a miss.
  await writeFile(cache, '{not json')
  expect(await cachedFileDigest(path, cache)).toEqual(await fileDigest(path))
  await writeFile(cache, JSON.stringify({ ...stored, path: join(directory, 'other') }))
  expect(await cachedFileDigest(path, cache)).toEqual(await fileDigest(path))
  // An unwritable cache location still returns the digest.
  await writeFile(join(directory, 'blocked'), 'a file, not a directory')
  expect(await cachedFileDigest(path, join(directory, 'blocked', 'cache.json'))).toEqual(
    await fileDigest(path)
  )
})
