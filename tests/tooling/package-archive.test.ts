import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import recorded from '../fixtures/package-archive-duplicate.json'
import type { FileDigest } from '../../scripts/native/artifact.ts'
import { verifyPackageArchive } from '../../scripts/native/package-archive.ts'
import { fixtureDigest } from './package-fixture.ts'

const recordedBytes = Buffer.from(recorded.archive.base64, 'base64')
const first = gunzipSync(recordedBytes).subarray(0, 1024)
const contents = 'first entry\n'
const expected: Record<string, FileDigest> = { 'index.ts': fixtureDigest(contents) }

function member(kind: string, name: string, link = '', prefix = ''): Buffer {
  // Mutate an independent Python USTAR fixture, not a header from the verifier.
  const header = Buffer.from(first.subarray(0, 512))
  header.fill(0, 0, 100)
  header.write(name, 0, 'latin1')
  header[156] = kind.charCodeAt(0)
  header.fill(0, 157, 257)
  header.write(link, 157, 'latin1')
  header.fill(0, 345, 500)
  header.write(prefix, 345, 'latin1')
  if (kind !== '0') header.write('00000000000\0', 124, 'latin1')
  header.fill(32, 148, 156)
  const sum = header.reduce((total, byte) => total + byte, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  return kind === '0' ? Buffer.concat([header, first.subarray(512)]) : header
}

test('raw package tar validation rejects duplicate, link and malformed member structure before extraction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-raw-archive-unit-'))
  const path = join(directory, 'input.tgz')
  const verify = async (raw: Buffer, inventory = expected) => {
    await writeFile(path, gzipSync(raw))
    await verifyPackageArchive(path, inventory)
  }
  const archive = (...members: Buffer[]) => Buffer.concat([...members, Buffer.alloc(1024)])
  try {
    expect(fixtureDigest(recordedBytes)).toEqual({
      bytes: recorded.archive.bytes,
      sha256: recorded.archive.sha256,
    })
    expect(recorded.originalMembers).toHaveLength(2)
    expect(recorded.pinnedReaderObservation.entries).toHaveLength(1)
    // Regular member plus its optional directory and USTAR prefix forms are valid.
    await verify(archive(member('5', 'package/'), first))
    await verify(archive(member('0', 'index.ts', '', 'package')))
    // The first recorded payload matches; the second original name is rejected.
    await writeFile(path, recordedBytes)
    await expect(verifyPackageArchive(path, expected)).rejects.toThrow(
      'Duplicate package tar member'
    )
    // Identical bytes and alternate header name/prefix forms still count twice.
    await expect(verify(archive(first, member('0', 'index.ts', '', 'package')))).rejects.toThrow(
      'Duplicate package tar member'
    )
    for (const kind of ['1', '2', 'x'])
      await expect(
        verify(archive(first, member(kind, 'package/link.ts', '../../outside')))
      ).rejects.toThrow('Unsupported package tar member type or link')
    await expect(verify(archive(member('0', 'package/../outside')))).rejects.toThrow('invalid path')
    await expect(verify(archive(member('5', 'unexpected/'), first))).rejects.toThrow(
      'Unexpected package tar directory'
    )
    await expect(verify(archive(member('0', 'package/extra.ts')))).rejects.toThrow(
      'inventory differs'
    )
    const badChecksum = Buffer.from(first)
    badChecksum[0] = 0
    await expect(verify(archive(badChecksum))).rejects.toThrow('checksum')
    const badPadding = Buffer.from(first)
    badPadding[512 + Buffer.byteLength(contents)] = 1
    await expect(verify(archive(badPadding))).rejects.toThrow('member padding')
    await expect(verify(first)).rejects.toThrow('no end records')
    await expect(verify(Buffer.concat([first, Buffer.alloc(512)]))).rejects.toThrow('end records')
    await expect(verify(Buffer.concat([archive(first), first.subarray(0, 512)]))).rejects.toThrow(
      'trailing data'
    )
    await expect(verify(archive(first).subarray(0, -1))).rejects.toThrow(
      'Truncated package tar blocks'
    )
    await expect(
      verify(archive(first), { ...expected, 'missing.ts': fixtureDigest('missing') })
    ).rejects.toThrow('inventory differs')
    await expect(verify(Buffer.concat([archive(first), Buffer.alloc(100_000)]))).rejects.toThrow()
    expect(existsSync(join(directory, 'outside'))).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
