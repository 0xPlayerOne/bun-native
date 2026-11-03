import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { extractPinnedExecutable } from '../../scripts/install-bun/archive.mjs'
import { MAX_UNPACKED_BYTES } from '../../scripts/install-bun/download.mjs'
import toolchain from '../../toolchain.json'

type Target = keyof typeof toolchain.bun.packages
type Entry = { name: string; body: Buffer; type?: string; size?: number }

function checksum(header: Buffer) {
  header.fill(32, 148, 156)
  const sum = header.reduce((total, byte) => total + byte, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
}

function tar(entries: Entry[]) {
  return Buffer.concat([
    ...entries.flatMap((entry) => {
      const header = Buffer.alloc(512)
      header.write(entry.name, 0, 100, 'ascii')
      header.write(
        (entry.size ?? entry.body.length).toString(8).padStart(11, '0') + '\0',
        124,
        'ascii'
      )
      header.write(entry.type ?? '0', 156, 'ascii')
      header.write('ustar\0' + '00', 257, 'ascii')
      checksum(header)
      return [header, entry.body, Buffer.alloc((512 - (entry.body.length % 512)) % 512)]
    }),
    Buffer.alloc(1024),
  ])
}

function fixture(target: Target = 'linux-x64') {
  const pin = toolchain.bun.packages[target]
  const [os, cpu] = target.split('-')
  const binary = Buffer.from(`Non-executable archive parser fixture for ${target}`)
  const entries = [
    { name: `package/bin/${os === 'win32' ? 'bun.exe' : 'bun'}`, body: binary },
    {
      name: 'package/package.json',
      body: Buffer.from(
        JSON.stringify({
          name: pin.name,
          version: pin.version,
          os: [os],
          cpu: [cpu],
        })
      ),
    },
    {
      name: 'package/README.md',
      body: Buffer.from('Archive parser fixture, not a native qualification.'),
    },
  ]
  return { entries, binary, target, pin }
}

function pack(value: ReturnType<typeof fixture>, entries: Entry[] = value.entries) {
  const compressed = gzipSync(tar(entries))
  return {
    compressed,
    pin: {
      ...value.pin,
      unpackedSize: entries.reduce((total, entry) => total + entry.body.length, 0),
      integrity: `sha512-${createHash('sha512').update(compressed).digest('base64')}`,
    },
  }
}

test.each(Object.keys(toolchain.bun.packages) as Target[])(
  'extracts only the expected regular executable for %s without writing archive paths',
  (target) => {
    const value = fixture(target)
    const { compressed, pin } = pack(value)
    expect(extractPinnedExecutable(compressed, pin, target)).toEqual(value.binary)
  }
)

test('path traversal, absolute paths, unexpected files and duplicate members fail closed', () => {
  const value = fixture()
  for (const name of [
    '../bun',
    '/tmp/bun',
    'package/bin/../../bun',
    'package/extra',
    'package/package.json',
  ]) {
    const entries = value.entries.map((entry, index) => (index === 0 ? { ...entry, name } : entry))
    const { compressed, pin } = pack(value, entries)
    expect(() => extractPinnedExecutable(compressed, pin, value.target)).toThrow(/path/)
  }
})

test.each(['1', '2', '5', 'x', 'g', 'L'])(
  'rejects link, directory and extended-header type %s',
  (type) => {
    const value = fixture()
    const entries = value.entries.map((entry, index) => (index === 0 ? { ...entry, type } : entry))
    const { compressed, pin } = pack(value, entries)
    expect(() => extractPinnedExecutable(compressed, pin, value.target)).toThrow(/nonregular/)
  }
)

test('corrupt gzip, expansion, member-size and numeric bounds are enforced', () => {
  const value = fixture()
  const { compressed, pin } = pack(value)
  expect(() => extractPinnedExecutable(Buffer.from('not gzip'), pin, value.target)).toThrow(/gzip/)
  expect(() => extractPinnedExecutable(compressed, pin, value.target, 1024)).toThrow(
    /expanded byte bound/
  )
  expect(() =>
    extractPinnedExecutable(compressed, pin, value.target, MAX_UNPACKED_BYTES + 1)
  ).toThrow(/expanded byte bound/)
  for (const [index, size] of [
    [0, 160 * 1024 * 1024 + 1],
    [1, 16_385],
    [2, 0],
  ] as const) {
    const entries = value.entries.map((entry, i) => (i === index ? { ...entry, size } : entry))
    const packed = pack(value, entries)
    expect(() => extractPinnedExecutable(packed.compressed, packed.pin, value.target)).toThrow(
      /member exceeds/
    )
  }
  const invalid = gunzipSync(compressed)
  invalid.fill(255, 124, 136)
  checksum(invalid.subarray(0, 512))
  expect(() => extractPinnedExecutable(gzipSync(invalid), pin, value.target)).toThrow(/numeric/)
})

test('header checksum, format, content padding and terminal blocks are validated', () => {
  const value = fixture()
  const { compressed, pin } = pack(value)
  const original = gunzipSync(compressed)
  const brokenChecksum = Buffer.from(original)
  brokenChecksum[100] = 42
  expect(() => extractPinnedExecutable(gzipSync(brokenChecksum), pin, value.target)).toThrow(
    /checksum/
  )
  const brokenFormat = Buffer.from(original)
  brokenFormat.write('other', 257, 'ascii')
  checksum(brokenFormat.subarray(0, 512))
  expect(() => extractPinnedExecutable(gzipSync(brokenFormat), pin, value.target)).toThrow(/format/)
  const brokenPadding = Buffer.from(original)
  brokenPadding[512 + value.binary.length] = 1
  expect(() => extractPinnedExecutable(gzipSync(brokenPadding), pin, value.target)).toThrow(
    /padding/
  )
  for (const content of [
    original.subarray(0, original.length - 512),
    Buffer.concat([original, Buffer.from([1])]),
    Buffer.concat([original, Buffer.alloc(512, 1)]),
  ])
    expect(() => extractPinnedExecutable(gzipSync(content), pin, value.target)).toThrow()
})

test('missing files, unpacked size, target and archived package identity must all match', () => {
  const value = fixture()
  const packed = pack(value)
  expect(() =>
    extractPinnedExecutable(
      packed.compressed,
      { ...packed.pin, unpackedSize: packed.pin.unpackedSize + 1 },
      value.target
    )
  ).toThrow(/unpacked size/)
  expect(() => extractPinnedExecutable(packed.compressed, packed.pin, 'darwin-x64')).toThrow(
    /host target/
  )
  expect(() => extractPinnedExecutable(packed.compressed, packed.pin, 'unknown-target')).toThrow(
    /Unsupported/
  )
  const missing = pack(value, value.entries.slice(0, 2))
  expect(() => extractPinnedExecutable(missing.compressed, missing.pin, value.target)).toThrow(
    /file set/
  )
  for (const replacement of [
    '{}',
    JSON.stringify({ name: value.pin.name, version: 'wrong', os: ['linux'], cpu: ['x64'] }),
    '{',
  ]) {
    const entries = value.entries.map((entry, index) =>
      index === 1 ? { ...entry, body: Buffer.from(replacement) } : entry
    )
    const changed = pack(value, entries)
    expect(() => extractPinnedExecutable(changed.compressed, changed.pin, value.target)).toThrow(
      /metadata/
    )
  }
})
