import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { NativeTransport } from '../../packages/runtime/src/native-transport.ts'
import { decodeRpc, encodeRpc } from '../../packages/contracts/src/rpc-wire.ts'
import { rpcLimits } from '../../packages/contracts/src/rpc.ts'
import { withCefRuntime } from '../../packages/artifacts/src/cef-cache.ts'
import type { CefResolveOptions } from '../../packages/artifacts/src/cef-cache.ts'
import type {
  CefMember,
  CefRuntimeIdentity,
  CefRuntimeManifest,
} from '../../packages/artifacts/src/cef-manifest.ts'

export interface ProfileWorkload {
  readonly name: string
  readonly parameters: Readonly<Record<string, number | string>>
  run(): void | Promise<void>
}
const ready = Buffer.from('{"v":1,"event":"ready","abi":1,"cef":"156.0.7"}\n')
const shutdown = Buffer.from('{"v":1,"event":"shutdown"}\n')

function nativeInput(events: number, title: string, chunkBytes: number) {
  const frames = Array.from({ length: events }, (_, index) =>
    Buffer.from(
      JSON.stringify({
        v: 1,
        event: 'view.title',
        target: 1,
        data: { title, index },
      }) + '\n'
    )
  )
  const bytes = Buffer.concat([ready, ...frames, shutdown])
  const parts: Buffer[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkBytes)
    parts.push(bytes.subarray(offset, offset + chunkBytes))
  return { parts, events, bytes: bytes.length, chunkBytes }
}

async function receiveNative(input: ReturnType<typeof nativeInput>): Promise<void> {
  let seen = 0
  const transport = new NativeTransport(Readable.from(input.parts), new PassThrough())
  transport.onEvent((event) => {
    if (event.event === 'view.title') {
      assert.equal(event.data?.['index'], seen)
      seen++
    }
  })
  await transport.closed
  assert.equal(transport.failure, null)
  assert.equal(seen, input.events)
  assert.deepEqual(transport.diagnostics(), {
    requests: 0,
    abandoned: 0,
    queuedBytes: 0,
    listeners: 0,
    closed: true,
  })
}

async function roundTrips(): Promise<void> {
  const input = new PassThrough(),
    output = new PassThrough()
  const transport = new NativeTransport(input, output)
  output.on('data', (bytes: Buffer) => {
    const request = JSON.parse(bytes.toString()) as { id: number; args: { n: number } }
    input.write(JSON.stringify({ v: 1, id: request.id, ok: true, value: request.args.n }) + '\n')
  })
  input.write(ready)
  await transport.ready
  try {
    for (let n = 0; n < 512; n++) assert.equal(await transport.call('diagnostics', { n }), n)
  } finally {
    input.write(shutdown)
    await transport.closed
  }
  assert.equal(transport.failure, null)
}

/** A signed, offline, synthetic runtime inventory exercises actual cache verification. */
async function cacheFixture(parent: string) {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, 'cache-profile-'))
  try {
    const key = 'a'.repeat(64),
      cached = join(directory, key)
    await mkdir(join(cached, 'resources'), { recursive: true, mode: 0o700 })
    await writeFile(join(directory, key + '.lock'), '', { mode: 0o600 })
    const identity: CefRuntimeIdentity = {
      kind: 'cef-runtime',
      version: '0.1.0',
      abi: 1,
      target: 'darwin-arm64',
      bun: '1.4.3',
      cef: '156.0.7',
      chromium: '156.0.8078.17',
      cefRs: 'b'.repeat(40),
      nativeToolchain: 'rust-1.91.0',
    }
    const members: CefMember[] = [{ path: 'resources', type: 'directory', mode: 0o700 }]
    for (const [path, bytes] of [
      ['host', Buffer.from('synthetic host; never executed')],
      ['helper', Buffer.from('synthetic helper; never executed')],
      ['resources/bun', Buffer.from('synthetic Bun; never executed')],
      [
        'resources/runtime.json',
        Buffer.from(
          JSON.stringify({ schema: 1, protocol: 1, bun_version: '1.4.3', cef_version: '156.0.7' })
        ),
      ],
      ['LICENSE', Buffer.from('Synthetic fixture only, not a distributed runtime.')],
      ['large.bin', Buffer.alloc(64 * 1024 * 1024, 81)],
    ] as const) {
      const mode = path.endsWith('.json') ? 0o600 : 0o700
      await writeFile(join(cached, path), bytes, { mode })
      members.push({
        path,
        type: 'file',
        mode,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
    const manifest: CefRuntimeManifest = {
      schema: 2,
      identity,
      archive: {
        url: 'https://fixture.invalid/runtime.tar.gz',
        size: 1,
        sha256: key,
        tarBytes:
          1024 +
          members.reduce(
            (total, member) =>
              total + 512 + (member.type === 'file' ? Math.ceil(member.size / 512) * 512 : 0),
            0
          ),
        format: 'ustar-gzip',
      },
      members,
      layout: {
        executable: 'host',
        bun: 'resources/bun',
        resources: 'resources',
        helpers: ['helper'],
      },
      notices: ['LICENSE'],
      locales: 'all',
      debugSymbols: false,
    }
    const keys = generateKeyPairSync('ed25519'),
      payload = Buffer.from(JSON.stringify(manifest))
    const options: CefResolveOptions = {
      cacheRoot: directory,
      expected: identity,
      offline: true,
      timeoutMs: 30000,
      allowedOrigins: ['https://fixture.invalid'],
      trustRoots: { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      envelope: {
        keyId: 'fixture',
        payload: payload.toString('base64'),
        signature: sign(null, payload, keys.privateKey).toString('base64'),
      },
      fetcher: async () => {
        throw new Error('Offline profile attempted a download')
      },
    }
    return {
      run: () =>
        withCefRuntime(options, async (path) => {
          assert.equal(path, cached)
        }),
      close: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function portableWorkloads(parent: string): Promise<{
  readonly workloads: readonly ProfileWorkload[]
  close(): Promise<void>
}> {
  const coalesced = nativeInput(4096, 'fixture title', 16384)
  const fragmented = nativeInput(8, 'λ'.repeat(24000), 64)
  const limits = rpcLimits()
  const value = Array.from({ length: 128 }, (_, index) => ({
    name: 'entry-' + index,
    path: 'app://ui/file-' + index,
    flags: [true, false],
    size: index,
  }))
  const packet = encodeRpc({ type: 'success', id: 1, value }, limits)
  const control = encodeRpc({ type: 'success', id: 1, value: null }, limits)
  const cache = await cacheFixture(parent)
  const decode = (bytes: Uint8Array, iterations: number, records: number) => {
    let counted = 0
    for (let index = 0; index < iterations; index++) {
      const decoded = decodeRpc(bytes, limits)
      assert.equal(decoded.type, 'success')
      if (decoded.type !== 'success') throw new Error('RPC result changed')
      if (records) {
        assert.ok(Array.isArray(decoded.value))
        counted += decoded.value.length
      } else assert.equal(decoded.value, null)
    }
    assert.equal(counted, iterations * records)
  }
  return {
    workloads: [
      { name: 'native-sequential-roundtrip', parameters: { roundTrips: 512 }, run: roundTrips },
      {
        name: 'native-coalesced',
        parameters: {
          events: coalesced.events,
          inputBytes: coalesced.bytes,
          chunkBytes: coalesced.chunkBytes,
        },
        run: () => receiveNative(coalesced),
      },
      {
        name: 'native-fragmented-utf8',
        parameters: {
          events: fragmented.events,
          inputBytes: fragmented.bytes,
          chunkBytes: fragmented.chunkBytes,
        },
        run: () => receiveNative(fragmented),
      },
      {
        name: 'rpc-json-decode',
        parameters: { iterations: 256, packetBytes: packet.length, records: 128 },
        run: () => decode(packet, 256, 128),
      },
      {
        name: 'rpc-control-decode',
        parameters: { iterations: 4096, packetBytes: control.length },
        run: () => decode(control, 4096, 0),
      },
      {
        name: 'authenticated-cache-reuse',
        parameters: {
          verifiedFileBytes: 64 * 1024 * 1024,
          profile: 'synthetic signed offline cache; full content verification',
        },
        run: cache.run,
      },
    ],
    close: cache.close,
  }
}
