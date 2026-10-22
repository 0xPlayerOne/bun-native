import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  transferArtifact,
  transferBytes,
  validateArtifactTransfer,
  type ArtifactTransfer,
} from '../benchmarks/lib/artifact-transfer.ts'
const payload = Buffer.from('release payload\n'.repeat(4096))
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
async function fixture(
  handler: (request: Request, directory: string) => Response | Promise<Response>,
  run: (plan: ArtifactTransfer, directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-transfer-'))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => handler(request, directory),
  })
  try {
    await run(
      {
        category: 'first-run-download',
        url: server.url.origin + '/artifact?private=not-for-report',
        allowedOrigins: [server.url.origin],
        allowLoopbackHttp: true,
        path: 'downloads/app.bin',
        expectedBytes: payload.length,
        sha256: hash(payload),
      },
      directory
    )
  } finally {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}
async function clean(directory: string): Promise<void> {
  const files = await readdir(join(directory, 'downloads')).catch(() => [])
  expect(files.filter((name) => name.startsWith('.transfer-'))).toEqual([])
}
test('real chunked HTTP transfer counts actual payload and publishes exact verified bytes', async () => {
  await fixture(
    (request) => {
      expect(request.headers.get('accept-encoding')).toBe('identity')
      let offset = 0
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (offset === payload.length) {
              controller.close()
              return
            }
            const end = Math.min(offset + 797, payload.length)
            controller.enqueue(payload.subarray(offset, end))
            offset = end
          },
        })
      )
    },
    async (plan, directory) => {
      const result = await transferArtifact(plan, { workspace: directory })
      expect(result.status).toBe('passed')
      expect(result.receivedBytes).toBe(payload.length)
      expect(result.receivedSha256).toBe(hash(payload))
      expect(result.published).toBe(true)
      expect(await readFile(join(directory, plan.path))).toEqual(payload)
      expect(transferBytes(result).accounting).toBe('received-body')
      expect(JSON.stringify(result)).not.toContain('not-for-report')
      await clean(directory)
    }
  )
})
test('compressed file bytes remain file bytes; Content-Encoding is not silently decoded', async () => {
  await fixture(
    () => new Response(payload, { headers: { 'content-encoding': 'gzip' } }),
    async (plan, directory) => {
      const result = await transferArtifact(plan, { workspace: directory })
      expect(result.errorCode).toBe('TRANSFER_ENCODING_DENIED')
      expect(result.published).toBe(false)
      expect(() => transferBytes(result)).toThrow()
      await clean(directory)
    }
  )
})
test('wrong hash consumes recorded bytes but cannot publish or claim verified measurement', async () => {
  await fixture(
    () => new Response(payload),
    async (plan, directory) => {
      const result = await transferArtifact(
        { ...plan, sha256: 'a'.repeat(64) },
        { workspace: directory }
      )
      expect(result.errorCode).toBe('TRANSFER_HASH_MISMATCH')
      expect(result.receivedBytes).toBe(payload.length)
      expect(result.published).toBe(false)
      expect(() => transferBytes(result)).toThrow()
      await clean(directory)
    }
  )
})
test('short chunked body cannot pass because the expected header was absent', async () => {
  await fixture(
    () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(payload.subarray(0, 13))
            await Bun.sleep(10)
            c.close()
          },
        })
      ),
    async (plan, directory) => {
      const result = await transferArtifact(plan, { workspace: directory })
      expect(result.errorCode).toBe('TRANSFER_LENGTH_MISMATCH')
      expect(result.receivedBytes).toBe(13)
      await clean(directory)
    }
  )
})
test('oversize chunked body is stopped instead of overrunning the declared budget', async () => {
  await fixture(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(payload)
            c.close()
          },
        })
      ),
    async (plan, directory) => {
      const result = await transferArtifact({ ...plan, expectedBytes: 7 }, { workspace: directory })
      expect(result.errorCode).toBe('TRANSFER_BODY_OVERSIZE')
      expect(result.published).toBe(false)
      await clean(directory)
    }
  )
})
test('a declared Content-Length mismatch is rejected before accepting any bytes', async () => {
  await fixture(
    () => new Response(payload),
    async (plan, directory) => {
      const result = await transferArtifact(
        { ...plan, expectedBytes: payload.length + 1 },
        { workspace: directory }
      )
      expect(result.errorCode).toBe('TRANSFER_LENGTH_MISMATCH')
      expect(result.receivedBytes).toBe(0)
      await clean(directory)
    }
  )
})
test('same-origin redirect requires an explicit finite redirect budget', async () => {
  await fixture(
    (request) =>
      new URL(request.url).pathname === '/artifact'
        ? new Response(null, { status: 302, headers: { location: '/final' } })
        : new Response(payload),
    async (plan, directory) => {
      expect((await transferArtifact(plan, { workspace: directory })).errorCode).toBe(
        'TRANSFER_REDIRECT_LIMIT'
      )
      const result = await transferArtifact({ ...plan, maxRedirects: 1 }, { workspace: directory })
      expect(result.status).toBe('passed')
      expect(result.redirects).toBe(1)
      await clean(directory)
    }
  )
})
test('redirects cannot grant authority for a different loopback port or disclose its URL', async () => {
  let reached = false
  const denied = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      reached = true
      return new Response(payload)
    },
  })
  try {
    await fixture(
      () =>
        new Response(null, { status: 302, headers: { location: denied.url.origin + '/secret' } }),
      async (plan, directory) => {
        const result = await transferArtifact(
          { ...plan, maxRedirects: 1 },
          { workspace: directory }
        )
        expect(result.errorCode).toBe('TRANSFER_ORIGIN_DENIED')
        expect(reached).toBe(false)
        expect(JSON.stringify(result)).not.toContain('/secret')
        await clean(directory)
      }
    )
  } finally {
    await denied.stop(true)
  }
})
test('stalled body is cancelled on deadline and its incomplete staging file is removed', async () => {
  await fixture(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(payload.subarray(0, 11))
          },
        })
      ),
    async (plan, directory) => {
      const result = await transferArtifact(plan, { workspace: directory, timeoutMs: 150 })
      expect(result.errorCode).toBe('TRANSFER_DEADLINE')
      expect(result.receivedBytes).toBe(11)
      expect(result.elapsedMs).toBeLessThan(3000)
      expect(result.cleanupEstablished).toBe(true)
      await clean(directory)
    }
  )
})
test('cancelled caller makes no network request and publishes nothing', async () => {
  let requested = false
  await fixture(
    () => {
      requested = true
      return new Response(payload)
    },
    async (plan, directory) => {
      const controller = new AbortController()
      controller.abort()
      const result = await transferArtifact(plan, {
        workspace: directory,
        signal: controller.signal,
      })
      expect(result.errorCode).toBe('TRANSFER_CANCELLED')
      expect(requested).toBe(false)
      expect(result.published).toBe(false)
    }
  )
})
test('an existing destination is never replaced or treated as a free download', async () => {
  let requested = false
  await fixture(
    () => {
      requested = true
      return new Response(payload)
    },
    async (plan, directory) => {
      await mkdir(join(directory, 'downloads'))
      await writeFile(join(directory, plan.path), 'existing')
      const result = await transferArtifact(plan, { workspace: directory })
      expect(result.errorCode).toBe('TRANSFER_OUTPUT_EXISTS')
      expect(requested).toBe(false)
      expect(await readFile(join(directory, plan.path), 'utf8')).toBe('existing')
      await clean(directory)
    }
  )
})
test('concurrent creation at publication cannot be overwritten by rename semantics', async () => {
  await fixture(
    async (_request, directory) => {
      await writeFile(join(directory, 'downloads/app.bin'), 'other writer', { flag: 'wx' })
      return new Response(payload)
    },
    async (plan, directory) => {
      const result = await transferArtifact(plan, { workspace: directory })
      expect(result.status).toBe('failed')
      expect(result.published).toBe(false)
      expect(await readFile(join(directory, plan.path), 'utf8')).toBe('other writer')
      await clean(directory)
    }
  )
})
test('linked output parents are rejected without writing into the linked directory', async () => {
  await fixture(
    () => new Response(payload),
    async (plan, directory) => {
      const other = await mkdtemp(join(tmpdir(), 'bunly-transfer-other-'))
      try {
        await symlink(
          other,
          join(directory, 'downloads'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
        expect((await transferArtifact(plan, { workspace: directory })).errorCode).toBe(
          'TRANSFER_LINKED_PARENT'
        )
        expect(await readdir(other)).toEqual([])
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    }
  )
})
test('input validation requires explicit target, origin, length and digest', () => {
  const valid = {
    category: 'update',
    url: 'https://release.example/app',
    allowedOrigins: ['https://release.example'],
    path: 'downloads/update.bin',
    expectedBytes: 1,
    sha256: 'a'.repeat(64),
  }
  expect(validateArtifactTransfer(valid).category).toBe('update')
  for (const change of [
    { category: ['update'] },
    { expectedBytes: 0 },
    { expectedBytes: NaN },
    { sha256: 'latest' },
    { maxRedirects: 9 },
    { allowLoopbackHttp: 'true' },
    { tls: false },
    { url: 'file:///tmp/app' },
    { url: 'https://user:password@release.example/app' },
    { allowedOrigins: [] },
    { path: '../outside' },
    { path: 'C:/outside' },
    { path: 'downloads/NUL.txt' },
    { path: 'downloads/../other' },
    { path: 'downloads/app.' },
  ]) {
    expect(() => validateArtifactTransfer({ ...valid, ...change })).toThrow()
  }
  expect(() =>
    validateArtifactTransfer({
      ...valid,
      url: 'http://127.0.0.1:5555/app',
      allowedOrigins: ['http://127.0.0.1:5555'],
    })
  ).toThrow()
})
test('HTTP errors remain failures even when they include the expected payload', async () => {
  await fixture(
    () => new Response(payload, { status: 403 }),
    async (plan, directory) => {
      const result = await transferArtifact(plan, { workspace: directory })
      expect(result.errorCode).toBe('TRANSFER_HTTP_STATUS')
      expect(result.status).toBe('failed')
      await clean(directory)
    }
  )
})
