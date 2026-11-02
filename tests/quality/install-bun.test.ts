import { afterEach, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { downloadPinnedArchive, MAX_ARCHIVE_BYTES } from '../../scripts/install-bun/download.mjs'
import toolchain from '../../toolchain.json'

const payload = Buffer.from('pinned archive fixture')
const archive = {
  ...toolchain.bun.packages['linux-x64'],
  integrity: `sha512-${createHash('sha512').update(payload).digest('base64')}`,
}
const temporary: string[] = []
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

function sequence(...responses: Response[]) {
  const requests: { url: string; options: RequestInit }[] = []
  const records: unknown[] = []
  return {
    requests,
    records,
    options: {
      report: (record: unknown) => records.push(record),
      fetchImplementation: async (url: URL, options: RequestInit) => {
        requests.push({ url: url.href, options })
        const response = responses.shift()
        if (!response) throw new Error('Unexpected additional request')
        return response
      },
    },
  }
}

test('exact official npm download has no credential or redirect and verifies SHA-512', async () => {
  const http = sequence(new Response(payload))
  expect(await downloadPinnedArchive(archive, http.options)).toEqual(payload)
  expect(http.requests).toHaveLength(1)
  const request = http.requests[0]!
  expect(request.url).toBe(archive.url)
  expect(new Headers(request.options.headers).has('authorization')).toBe(false)
  expect(new Headers(request.options.headers).get('accept-encoding')).toBe('identity')
  expect(request.options.credentials).toBe('omit')
  expect(request.options.redirect).toBe('manual')
  expect(request.options.signal?.aborted).toBe(false)
  expect(http.records).toEqual([{ phase: 'npm-archive', status: 200 }])
})

test('the production reporter contains only safe HTTP phase and status metadata', async () => {
  const http = sequence(new Response(payload))
  expect(
    await downloadPinnedArchive(archive, { fetchImplementation: http.options.fetchImplementation })
  ).toEqual(payload)
})

test.each([301, 302, 307, 308, 401, 403, 404])(
  'HTTP %s fails once without fallback or body disclosure',
  async (status) => {
    let cancelled = false
    const http = sequence(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
        {
          status,
          headers: { location: 'https://private.invalid/token', 'x-request-id': 'private' },
        }
      )
    )
    await assert.rejects(downloadPinnedArchive(archive, http.options), new RegExp(`HTTP ${status}`))
    expect(http.requests).toHaveLength(1)
    expect(cancelled).toBe(true)
    expect(JSON.stringify(http.records)).not.toContain('private')
  }
)

test('invalid names, versions, URLs, digests and bounds fail before network activity', async () => {
  const http = sequence()
  for (const pin of [
    { ...archive, name: '@other/bun-linux-x64' },
    { ...archive, version: 'latest' },
    { ...archive, url: archive.url.replace('https:', 'http:') },
    {
      ...archive,
      url: archive.url.replace('registry.npmjs.org', 'registry.npmjs.org.attacker.invalid'),
    },
    { ...archive, url: archive.url.replace('https://', 'https://user:secret@') },
    { ...archive, url: `${archive.url}?token=secret` },
    { ...archive, integrity: 'sha512-invalid' },
    { ...archive, unpackedSize: -1 },
  ])
    await assert.rejects(downloadPinnedArchive(pin, http.options))
  await assert.rejects(
    downloadPinnedArchive(archive, { ...http.options, timeoutMs: 120_001 }),
    /deadline/
  )
  await assert.rejects(
    downloadPinnedArchive(archive, { ...http.options, maxArchiveBytes: MAX_ARCHIVE_BYTES + 1 }),
    /bound/
  )
  expect(http.requests).toHaveLength(0)
})

test('changed bytes and truncated declarations fail before extraction can receive data', async () => {
  await assert.rejects(
    downloadPinnedArchive(archive, sequence(new Response('changed')).options),
    /checksum/
  )
  await assert.rejects(
    downloadPinnedArchive(
      archive,
      sequence(
        new Response(payload, {
          headers: { 'content-length': String(payload.length + 1) },
        })
      ).options
    ),
    /length mismatch/
  )
  await assert.rejects(
    downloadPinnedArchive(
      archive,
      sequence(
        new Response(payload, {
          headers: { 'content-encoding': 'gzip' },
        })
      ).options
    ),
    /identity HTTP encoding/
  )
})

test('both declared and streamed compressed bodies have a hard byte bound', async () => {
  await assert.rejects(
    downloadPinnedArchive(archive, {
      ...sequence(new Response(payload, { headers: { 'content-length': '1024' } })).options,
      maxArchiveBytes: 16,
    }),
    /compressed byte bound/
  )
  let cancelled = false
  const http = sequence(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(17))
        },
        cancel() {
          cancelled = true
        },
      })
    )
  )
  await assert.rejects(
    downloadPinnedArchive(archive, { ...http.options, maxArchiveBytes: 16 }),
    /compressed byte bound/
  )
  expect(cancelled).toBe(true)
})

test('one deadline bounds a hanging request or body; cancellation cannot extend it', async () => {
  let signal: AbortSignal | null | undefined
  await assert.rejects(
    downloadPinnedArchive(archive, {
      timeoutMs: 20,
      fetchImplementation: async (_url, options) => {
        signal = options.signal
        return new Promise<Response>(() => {})
      },
    }),
    /deadline/
  )
  expect(signal?.aborted).toBe(true)
  let cancelled = false
  const http = sequence(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
          return new Promise<void>(() => {})
        },
      })
    )
  )
  await assert.rejects(
    downloadPinnedArchive(archive, { ...http.options, timeoutMs: 20 }),
    /deadline/
  )
  expect(http.requests[0]!.options.signal?.aborted).toBe(true)
  expect(cancelled).toBe(true)
})

test('request, body and cancellation errors never expose private exception contents', async () => {
  await assert.rejects(
    downloadPinnedArchive(archive, {
      fetchImplementation: async () => {
        throw new Error('private token')
      },
    }),
    { message: 'Pinned Bun download request failed' }
  )
  await assert.rejects(
    downloadPinnedArchive(
      archive,
      sequence(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('private body'))
            },
          })
        )
      ).options
    ),
    { message: 'Pinned Bun download body failed' }
  )
  await assert.rejects(
    downloadPinnedArchive(
      archive,
      sequence(
        new Response(
          new ReadableStream({
            cancel() {
              throw new Error('private cancellation')
            },
          }),
          { status: 403 }
        )
      ).options
    ),
    /HTTP 403/
  )
})

test('existing-install verification strips the obsolete token and makes no network request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-installer-env-'))
  temporary.push(directory)
  const destination = join(directory, 'installed')
  const executable = join(destination, process.platform === 'win32' ? 'bun.exe' : 'bun')
  await Bun.write(
    executable,
    'This fixture intercepts subprocess creation; it is not an executable.'
  )
  const preload = join(directory, 'guard.mjs')
  await Bun.write(
    preload,
    `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = (_command, _args, options) => {
  if (process.env.BUN_NATIVE_GITHUB_TOKEN || options.env?.BUN_NATIVE_GITHUB_TOKEN) throw new Error('Credential inherited by child');
  return { status: 0, stdout: ${JSON.stringify(toolchain.bun.cliRevision)}, stderr: '' };
};
globalThis.fetch = () => { throw new Error('Existing install must not download'); };
syncBuiltinESMExports();
`
  )
  const result = spawnSync(
    'node',
    [
      '--import',
      pathToFileURL(preload).href,
      resolve(import.meta.dir, '../../scripts/install-bun.mjs'),
      '--destination',
      destination,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, BUN_NATIVE_GITHUB_TOKEN: 'ghs_subprocess_fixture', GITHUB_PATH: '' },
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).not.toContain('ghs_subprocess_fixture')
  expect(JSON.parse(result.stdout).revision).toBe(toolchain.bun.cliRevision)
  expect(JSON.parse(result.stdout).downloadedIntegrity).toBeNull()
})
