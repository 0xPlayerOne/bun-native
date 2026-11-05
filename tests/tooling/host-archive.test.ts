import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { hostArchive, sourceDateEpoch } from '../../scripts/native/host-archive.ts'

const script = resolve(import.meta.dir, '../../scripts/native/host-archive.ts')
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

function withDirectory(exercise: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-host-archive-'))
  try {
    exercise(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function pack(input: string, output: string, epoch?: string) {
  const { SOURCE_DATE_EPOCH: _unset, ...env } = process.env
  return Bun.spawnSync([process.execPath, script, '--output', output, input], {
    env: epoch === undefined ? env : { ...env, SOURCE_DATE_EPOCH: epoch },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  })
}

describe('reproducible native host archive', () => {
  test('equal executables pack to identical bytes regardless of path, mtime or owner', () => {
    withDirectory((directory) => {
      const outputs: string[] = []
      for (const [index, [folder, seconds, mode]] of (
        [
          ['first', 1_000_000_000, 0o755],
          ['second/deeper/build', 1_900_000_000, 0o700],
        ] as const
      ).entries()) {
        mkdirSync(join(directory, folder), { recursive: true })
        const input = join(directory, folder, 'bun-native-host')
        writeFileSync(input, 'fixture native host\n')
        chmodSync(input, mode)
        utimesSync(input, seconds, seconds)
        const output = join(directory, `archive-${index}.tar.gz`)
        const result = pack(input, output, '1700000000')
        expect(result.stderr.toString()).toBe('')
        expect(result.exitCode).toBe(0)
        outputs.push(output)
      }
      const [first, second] = outputs.map((path) => readFileSync(path))
      expect(Buffer.compare(first!, second!)).toBe(0)
      // A golden digest makes any packer, zlib or header change visible.
      expect(sha256(first!)).toBe(
        'db1e35c19fdddcf32c193d7bcbe3caed44d2e9ad4ddb3487ca533d733ebca3a5'
      )
      expect(
        pack(join(directory, 'first/bun-native-host'), outputs[0]!, '1700000000').exitCode
      ).not.toBe(0) // never overwrites a previous archive
    })
  })

  test('platform tar extracts the exact executable with the fixed metadata', () => {
    withDirectory((directory) => {
      const data = Buffer.from(Array.from({ length: 1500 }, (_, index) => index % 251))
      const archive = join(directory, 'host.tar.gz')
      writeFileSync(archive, hostArchive([{ name: 'bun-native-host', data }], 1_700_000_000))
      const extracted = join(directory, 'extracted')
      mkdirSync(extracted)
      const result = Bun.spawnSync(['tar', '-xzf', archive, '-C', extracted], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15_000,
      })
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
      const file = join(extracted, 'bun-native-host')
      expect(Buffer.compare(readFileSync(file), data)).toBe(0)
      expect(statSync(file).mtimeMs).toBe(1_700_000_000_000)
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o755)
    })
  })

  test('headers carry no machine identity and members are sorted', () => {
    const archive = hostArchive(
      [
        { name: 'zeta', data: new Uint8Array([1]) },
        { name: 'alpha.exe', data: new Uint8Array(513) },
      ],
      42
    )
    expect([...archive.subarray(0, 10)]).toEqual([
      0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff,
    ])
    const tar = gunzipSync(archive)
    expect(tar.length % 10_240).toBe(0)
    const first = tar.subarray(0, 512)
    const second = tar.subarray(512 * 3, 512 * 4)
    expect(first.subarray(0, 9).toString('latin1')).toBe('alpha.exe')
    expect(second.subarray(0, 4).toString('latin1')).toBe('zeta')
    for (const header of [first, second]) {
      expect(header.subarray(108, 124).toString('latin1')).toBe('0000000\0'.repeat(2))
      expect(header.subarray(136, 148).toString('latin1')).toBe('00000000052\0')
      expect(header.subarray(265, 345).every((byte) => byte === 0)).toBe(true)
    }
    expect(() =>
      hostArchive(
        [
          { name: 'same', data: new Uint8Array() },
          { name: 'same', data: new Uint8Array() },
        ],
        0
      )
    ).toThrow('Duplicate')
    for (const name of ['../escape', 'nested/host', '', '..'])
      expect(() => hostArchive([{ name, data: new Uint8Array() }], 0)).toThrow('flat portable')
  })

  test('SOURCE_DATE_EPOCH is validated and changes only the member time', () => {
    expect(sourceDateEpoch(undefined)).toBe(0)
    expect(sourceDateEpoch('')).toBe(0)
    expect(sourceDateEpoch('1700000000')).toBe(1_700_000_000)
    for (const value of ['-1', '1.5', 'now', '99999999999'])
      expect(() => sourceDateEpoch(value)).toThrow('SOURCE_DATE_EPOCH')
    const member = [{ name: 'bun-native-host', data: new Uint8Array([7]) }]
    expect(Buffer.compare(hostArchive(member, 1), hostArchive(member, 1))).toBe(0)
    expect(Buffer.compare(hostArchive(member, 1), hostArchive(member, 2))).not.toBe(0)
  })
})
