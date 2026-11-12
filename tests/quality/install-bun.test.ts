import { afterEach, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  downloadPinnedArchive,
  MAX_ARCHIVE_BYTES,
  validatePackagePin,
} from '../../scripts/install-bun/download.mjs'
import toolchain from '../../toolchain.json'
import bridgePairsToolchain from '../../benchmarks/bridge-pairs-toolchain.json'

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

test('the default options reject an invalid pin before any production fetch', async () => {
  await assert.rejects(downloadPinnedArchive({ ...archive, version: 'latest' }), {
    message: 'Invalid exact official Bun package pin',
  })
})

test('a synchronously throwing body cancellation cannot replace the HTTP failure', async () => {
  let cancellations = 0
  const response = {
    status: 404,
    headers: new Headers(),
    body: {
      cancel() {
        cancellations += 1
        throw new Error('private synchronous cancellation')
      },
    },
  } as unknown as Response
  await assert.rejects(
    downloadPinnedArchive(archive, {
      ...sequence().options,
      fetchImplementation: async () => response,
    }),
    { message: 'Pinned Bun download failed with HTTP 404' }
  )
  expect(cancellations).toBe(1)
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
          headers: { 'content-length': String(payload.length - 1) },
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

test.each([false, true])(
  'one-byte fragments preserve verified bytes with declared length %s',
  async (declared) => {
    const bytes = Uint8Array.from({ length: 8192 }, (_, index) => index % 251)
    const pin = {
      ...archive,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    }
    let emitted = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.subarray(emitted, emitted + 1))
        emitted += 1
      },
    })
    const http = sequence(
      new Response(
        body,
        declared ? { headers: { 'content-length': String(bytes.length) } } : undefined
      )
    )
    expect(
      await downloadPinnedArchive(pin, { ...http.options, maxArchiveBytes: bytes.length })
    ).toEqual(Buffer.from(bytes))
    expect(emitted).toBe(bytes.length)
    expect(http.requests).toHaveLength(1)
  }
)

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

function consumeSynchronousTime() {
  const stop = performance.now() + 10
  while (performance.now() < stop) {
    // Deliberately keep this turn synchronous: a timeout task cannot run yet.
  }
}

test('an immediately fulfilled fetch cannot succeed after starving the deadline timer', async () => {
  let signal: AbortSignal | null | undefined
  await assert.rejects(
    downloadPinnedArchive(archive, {
      timeoutMs: 5,
      maxArchiveBytes: payload.length,
      fetchImplementation: async (_url, options) => {
        signal = options.signal
        consumeSynchronousTime()
        return new Response(payload)
      },
    }),
    /deadline/
  )
  expect(signal?.aborted).toBe(true)
})

test('an immediately fulfilled body read cannot succeed after starving the deadline timer', async () => {
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        consumeSynchronousTime()
        controller.enqueue(payload)
        controller.close()
      },
    },
    { highWaterMark: 0 }
  )
  const http = sequence(new Response(body))
  await assert.rejects(
    downloadPinnedArchive(archive, {
      ...http.options,
      timeoutMs: 5,
      maxArchiveBytes: payload.length,
    }),
    /deadline/
  )
  expect(http.requests[0]!.options.signal?.aborted).toBe(true)
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

async function runInstallerAgainstExistingFixture(
  extraArgs: (directory: string) => string[],
  reportedRevision: string
) {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-installer-manifest-'))
  temporary.push(directory)
  const destination = join(directory, 'installed')
  await Bun.write(
    join(destination, process.platform === 'win32' ? 'bun.exe' : 'bun'),
    'This fixture intercepts subprocess creation; it is not an executable.'
  )
  const preload = join(directory, 'guard.mjs')
  await Bun.write(
    preload,
    `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = () => ({ status: 0, stdout: ${JSON.stringify(reportedRevision)}, stderr: '' });
globalThis.fetch = () => { throw new Error('Existing install must not download'); };
syncBuiltinESMExports();
`
  )
  return spawnSync(
    'node',
    [
      '--import',
      pathToFileURL(preload).href,
      resolve(import.meta.dir, '../../scripts/install-bun.mjs'),
      '--destination',
      destination,
      ...extraArgs(directory),
    ],
    { encoding: 'utf8', timeout: 10_000, env: { ...process.env, GITHUB_PATH: '' } }
  )
}

test('the historical bridge-pairs pin is the exact npm build of the BN1 Bun revision', () => {
  const { bun } = bridgePairsToolchain
  expect(bridgePairsToolchain.schemaVersion).toBe(2)
  expect(bun.distribution).toBe('npm')
  expect(bun.revision).toBe('da867c60bf0bcbf9d6d36994f8ca0efa42075115')
  expect(bun.cliRevision).toBe(`${bun.version}+${bun.revision.slice(0, 9)}`)
  expect(Object.keys(bun.packages)).toEqual(['linux-x64'])
  const pin = bun.packages['linux-x64']
  expect(validatePackagePin(pin).href).toBe(pin.url)
  expect(pin.version.endsWith(`+${bun.revision.slice(0, 7)}`)).toBe(true)
})

test('--manifest installs and verifies against the named pin instead of the repository pin', async () => {
  // The checked-in pin is linux-x64 only (the workflow's runner). Key the same
  // pin under this test's target so the option is exercised on every OS.
  const { bun } = bridgePairsToolchain
  const historical = bun.cliRevision
  const accepted = await runInstallerAgainstExistingFixture((directory) => {
    const manifest = join(directory, 'historical-toolchain.json')
    const packages = { [`${process.platform}-${process.arch}`]: bun.packages['linux-x64'] }
    writeFileSync(manifest, JSON.stringify({ ...bridgePairsToolchain, bun: { ...bun, packages } }))
    return ['--manifest', manifest]
  }, historical)
  expect(accepted.error).toBeUndefined()
  expect(accepted.stderr).toBe('')
  expect(accepted.status).toBe(0)
  expect(JSON.parse(accepted.stdout)).toMatchObject({
    revision: historical,
    reusedExisting: true,
    packageVersion: bridgePairsToolchain.bun.packages['linux-x64'].version,
  })
  // The same historical binary does not satisfy the default repository pin.
  const rejected = await runInstallerAgainstExistingFixture(() => [], historical)
  expect(rejected.status).not.toBe(0)
  expect(rejected.stderr).toContain(
    `Bun revision mismatch: expected ${toolchain.bun.cliRevision}, got ${historical}`
  )
})

test.each([
  ['a relative manifest path', () => ['--manifest', 'toolchain.json']],
  ['a misspelled option', (directory: string) => ['--manfest', join(directory, 'x.json')]],
  ['a missing manifest path', () => ['--manifest']],
])('the installer rejects %s with its usage', async (_name, extra) => {
  const result = await runInstallerAgainstExistingFixture(extra, toolchain.bun.cliRevision)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Usage: node scripts/install-bun.mjs --destination')
})

test('a manifest without the npm distribution is refused before any install', async () => {
  const result = await runInstallerAgainstExistingFixture((directory) => {
    const path = join(directory, 'legacy.json')
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, bun: {} }))
    return ['--manifest', path]
  }, toolchain.bun.cliRevision)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Expected the explicit npm Bun distribution manifest')
})

test('one deadline subscription covers every fragment of the complete download', () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dir, '../../scripts/install-bun/download.mjs')
  ).href
  const result = spawnSync(
    'node',
    [
      '--input-type=module',
      '--eval',
      `import { createHash } from 'node:crypto';
const { downloadPinnedArchive } = await import(${JSON.stringify(moduleUrl)});
const bytes = Buffer.alloc(1024, 42);
const pin = { ...${JSON.stringify(archive)}, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
let emitted = 0;
const response = new Response(new ReadableStream({
  pull(controller) {
    if (emitted === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(emitted, emitted + 1));
    emitted += 1;
  }
}, { highWaterMark: 0 }));
const originalRace = Promise.race;
const originalThen = Promise.prototype.then;
let deadlinePromise;
let deadlineSubscriptions = 0;
Promise.race = function(values) {
  const candidates = Array.from(values);
  deadlinePromise ??= candidates[1];
  return originalRace.call(this, candidates);
};
Promise.prototype.then = function(fulfilled, rejected) {
  if (this === deadlinePromise) deadlineSubscriptions += 1;
  return originalThen.call(this, fulfilled, rejected);
};
let output;
try {
  output = await downloadPinnedArchive(pin, {
    fetchImplementation: async () => response, report() {},
    timeoutMs: 1000, maxArchiveBytes: bytes.length
  });
} finally {
  Promise.race = originalRace;
  Promise.prototype.then = originalThen;
}
if (!output.equals(bytes)) throw new Error('Fragmented control bytes changed');
console.log(JSON.stringify({ fragments: emitted, bytes: output.length, deadlineSubscriptions }));
`,
    ],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384 }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    fragments: 1024,
    bytes: 1024,
    deadlineSubscriptions: 1,
  })
})

test('a late fetch response is cancelled once without reads or reporting after timeout', async () => {
  let release: ((response: Response) => void) | undefined
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  const records: unknown[] = []
  await assert.rejects(
    downloadPinnedArchive(archive, {
      fetchImplementation: () => pending,
      report: (record) => records.push(record),
      timeoutMs: 20,
    }),
    /deadline/
  )
  let notifyCancellation: (() => void) | undefined
  const cancelled = new Promise<void>((resolve) => {
    notifyCancellation = resolve
  })
  let cancellations = 0
  let reads = 0
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull() {
          reads += 1
        },
        cancel() {
          cancellations += 1
          notifyCancellation?.()
        },
      },
      { highWaterMark: 0 }
    )
  )
  if (!release) throw new Error('The controlled fetch did not start')
  release(response)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cancelled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The late response body was not cancelled')), 500)
      }),
    ])
    expect(cancellations).toBe(1)
    expect(reads).toBe(0)
    expect(records).toEqual([])
  } finally {
    clearTimeout(timer)
    if (cancellations === 0) await response.body?.cancel()
  }
})
