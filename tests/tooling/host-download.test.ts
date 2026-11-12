import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostArchive, ustarGzip } from '../../scripts/native/host-archive.ts'
import {
  checksumFor,
  hostFromArchive,
  installReleaseHost,
  releaseHostAsset,
  releaseHostTarget,
  type ReleaseHostTarget,
} from '../../scripts/native/host-download.ts'
import { hostHeader } from './host-fixture.ts'

const supported =
  ['linux', 'darwin'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch)
const target = (
  supported ? `${process.platform}-${process.arch}` : 'linux-x64'
) as ReleaseHostTarget
const host = hostHeader(
  target.startsWith('linux') ? 'linux' : 'darwin',
  target.endsWith('arm64') ? 'arm64' : 'x64'
)
const archive = hostArchive([{ name: 'bun-native-host', data: host }], 1_700_000_000)
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('release host archives', () => {
  test('names one asset per released platform and refuses the rest', () => {
    expect(releaseHostTarget('linux', 'arm64')).toBe('linux-arm64')
    expect(releaseHostTarget('darwin', 'x64')).toBe('darwin-x64')
    expect(releaseHostAsset('darwin-arm64')).toBe('bun-native-host-darwin-arm64.tar.gz')
    expect(() => releaseHostTarget('win32', 'x64')).toThrow('No released native host for win32-x64')
  })

  test('reads exactly one listed digest from SHA256SUMS', () => {
    const digest = 'a'.repeat(64)
    expect(checksumFor(`${digest}  x.tar.gz\n${'b'.repeat(64)} *y.tar.gz\n`, 'x.tar.gz')).toBe(
      digest
    )
    expect(() => checksumFor(`${digest}  y.tar.gz\n`, 'x.tar.gz')).toThrow('exactly once (found 0)')
    expect(() => checksumFor(`${digest}  x.tar.gz\n${digest}  x.tar.gz\n`, 'x.tar.gz')).toThrow(
      'exactly once (found 2)'
    )
  })

  test('unpacks the single host member and rejects anything else', () => {
    expect(hostFromArchive(archive).equals(host)).toBe(true)
    const named = hostArchive([{ name: 'other', data: host }], 0)
    expect(() => hostFromArchive(named)).toThrow('must hold only bun-native-host, not other')
    const two = hostArchive(
      [
        { name: 'bun-native-host', data: host },
        { name: 'extra', data: host },
      ],
      0
    )
    expect(() => hostFromArchive(two)).toThrow('exactly one member')
    const nested = ustarGzip([{ name: 'bun-native-host', data: host, mode: 0o644 }], 0)
    expect(hostFromArchive(nested).equals(host)).toBe(true)
  })
})

describe.skipIf(!supported)('installReleaseHost', () => {
  let server: ReturnType<typeof Bun.serve>
  let directory: string
  let sums = ''
  let served = archive
  const requests: string[] = []
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'bun-native-host-download-'))
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        requests.push(path)
        if (path === '/v1.2.3/SHA256SUMS') return new Response(sums)
        if (path === `/v1.2.3/${releaseHostAsset(target)}`) return new Response(served)
        return new Response('missing', { status: 404 })
      },
    })
  })
  afterAll(() => {
    server.stop(true)
    rmSync(directory, { recursive: true, force: true })
  })

  test('installs a checksum-matched host once and reuses it', async () => {
    sums = `${sha(archive)}  ${releaseHostAsset(target)}\n`
    const options = { version: '1.2.3', baseUrl: server.url.href, cache: join(directory, 'hosts') }
    const installed = await installReleaseHost(options)
    expect(installed).toEndWith(join('v1.2.3', target, 'bun-native-host'))
    expect(readFileSync(installed).equals(host)).toBe(true)
    expect(statSync(installed).mode & 0o777).toBe(0o755)
    const count = requests.length
    expect(await installReleaseHost(options)).toBe(installed)
    expect(requests.length).toBe(count)
  })

  test('refuses a digest mismatch, a missing release and a bad version', async () => {
    served = Buffer.concat([archive, Buffer.from([0])])
    const options = { version: '1.2.3', baseUrl: server.url.href, cache: join(directory, 'other') }
    await expect(installReleaseHost(options)).rejects.toThrow('does not match SHA256SUMS')
    served = archive
    await expect(installReleaseHost({ ...options, version: '9.9.9' })).rejects.toThrow(
      'Download failed (404)'
    )
    await expect(installReleaseHost({ ...options, version: 'latest' })).rejects.toThrow(
      'must be x.y.z'
    )
  })
})
