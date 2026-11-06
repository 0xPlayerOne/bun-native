import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileDigest } from '../../scripts/native/artifact.ts'

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
