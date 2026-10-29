import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { acceptManagedComparisonReport } from '../benchmarks/reload/managed-comparison-report.ts'
import { checksum } from '../benchmarks/fixtures/data.ts'
import {
  acceptComparisonRows,
  COMPARISON_FORM,
  COMPARISON_PLAN,
  MANAGED_COMPARISON_PROFILE,
  comparisonChunk,
  comparisonTranscript,
  comparisonRenderer,
  COMPARISON_VERSIONS,
  createComparisonProbe,
  type ComparisonFramework,
  type ComparisonHost,
  type ComparisonObservation,
  type ComparisonRow,
} from '../benchmarks/reload/managed-comparison.ts'

function host(framework: ComparisonFramework, revision = 0): ComparisonHost {
  return {
    framework,
    revision,
    instance: randomUUID(),
    pid: 100,
    version: COMPARISON_VERSIONS[framework],
    runtimeVersion: '1.4.4',
    identities:
      framework === 'bunly'
        ? { window: randomUUID(), view: randomUUID(), session: randomUUID() }
        : null,
  }
}
function observation(framework: ComparisonFramework, revision: number): ComparisonObservation {
  const bytes = comparisonTranscript(revision)
  return {
    host: host(framework, revision),
    renderer: {
      revision,
      document: randomUUID(),
      form: COMPARISON_FORM,
      restored: framework !== 'bunly' && revision > 0,
      bytes: bytes.byteLength,
      checksum: checksum(bytes),
      lastSequence: (revision + 1) * 32 - 1,
      frameOpportunities: 2,
      nativeGlobalsAbsent: true,
    },
  }
}
function rows(framework: ComparisonFramework): ComparisonRow[] {
  const first = observation(framework, 0)
  return Array.from({ length: 5 }, (_, revision) => {
    const value = observation(framework, revision)
    return {
      revision,
      role: revision === 0 ? 'initial' : revision === 1 ? 'warmup' : 'measurement',
      status: 'passed',
      elapsedMs: revision * 10,
      failure: null,
      observation:
        framework === 'bunly'
          ? {
              host: { ...first.host, revision },
              renderer: { ...value.renderer, document: first.renderer.document },
            }
          : value,
    }
  })
}
test('shared outcome reports retention and restored state as distinct lifecycle semantics', () => {
  expect(acceptComparisonRows('bunly', rows('bunly'))).toMatchObject({
    persistence: 'retained-native-document',
    count: 3,
    medianMs: 30,
    performanceEligible: false,
  })
  for (const name of ['electrobun', 'mirin'] as const)
    expect(acceptComparisonRows(name, rows(name))).toMatchObject({
      persistence: 'relaunch-and-browser-storage',
      count: 3,
      medianMs: 30,
      performanceEligible: false,
    })
})
test('fixed plan rejects failed warmups, omitted samples, retries and non-finite durations', () => {
  const invalid = rows('bunly')
  invalid[1] = { ...invalid[1]!, status: 'failed', failure: 'did not complete' }
  expect(() => acceptComparisonRows('bunly', invalid)).toThrow()
  expect(() => acceptComparisonRows('bunly', rows('bunly').slice(1))).toThrow()
  const retry = rows('bunly')
  retry[2] = { ...retry[2]!, revision: 1 }
  expect(() => acceptComparisonRows('bunly', retry)).toThrow()
  const infinite = rows('bunly')
  infinite[2] = { ...infinite[2]!, elapsedMs: NaN }
  expect(() => acceptComparisonRows('bunly', infinite)).toThrow()
})
test('continuity validator rejects replaced native identity, lost form and truncated output', () => {
  for (const mutate of [
    (value: ComparisonObservation) => ({
      ...value,
      host: { ...value.host, instance: randomUUID() },
    }),
    (value: ComparisonObservation) => ({
      ...value,
      renderer: { ...value.renderer, document: randomUUID() },
    }),
    (value: ComparisonObservation) => ({ ...value, renderer: { ...value.renderer, form: '' } }),
    (value: ComparisonObservation) => ({ ...value, renderer: { ...value.renderer, bytes: 1 } }),
    (value: ComparisonObservation) => ({
      ...value,
      renderer: { ...value.renderer, restored: true },
    }),
  ]) {
    const invalid = rows('bunly')
    invalid[2] = { ...invalid[2]!, observation: mutate(invalid[2]!.observation!) }
    expect(() => acceptComparisonRows('bunly', invalid)).toThrow()
  }
  const forged = rows('mirin')
  forged[1] = {
    ...forged[1]!,
    observation: {
      ...forged[1]!.observation!,
      renderer: { ...forged[1]!.observation!.renderer, restored: false },
    },
  }
  expect(() => acceptComparisonRows('mirin', forged)).toThrow()
})

const probes: Awaited<ReturnType<typeof createComparisonProbe>>[] = []
afterEach(async () => {
  for (const probe of probes.splice(0)) await probe.close()
})
async function probe() {
  const value = await createComparisonProbe({
    framework: 'bunly',
    html: '<html></html>',
    javascript: 'void 0',
    terminalJs: 'void 0',
    terminalCss: 'body{}',
    timeoutMs: 1000,
  })
  probes.push(value)
  return value
}
test('real loopback probe separates host and renderer roles and accepts a bounded outcome', async () => {
  const value = await probe(),
    config = value.configuration
  const completion = value.expect(0),
    data = observation('bunly', 0)
  const hostHeaders = {
    'x-bunly-probe-token': config.hostToken,
    'content-type': 'application/json',
  }
  const pageHeaders = {
    'x-bunly-probe-token': config.rendererToken,
    origin: config.origin,
    'content-type': 'application/json',
  }
  expect(
    (
      await fetch(config.origin + '/host', {
        method: 'POST',
        headers: pageHeaders,
        body: JSON.stringify(data.host),
      })
    ).status
  ).toBe(403)
  expect(
    (
      await fetch(config.origin + '/host', {
        method: 'POST',
        headers: { ...hostHeaders, origin: config.origin },
        body: JSON.stringify(data.host),
      })
    ).status
  ).toBe(403)
  expect(
    (
      await fetch(config.origin + '/host', {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify(data.host),
      })
    ).status
  ).toBe(200)
  const descriptor = await fetch(config.origin + '/descriptor', { headers: pageHeaders })
  expect(await descriptor.json()).toMatchObject({ revision: 0, initialForm: COMPARISON_FORM })
  const bytes = new Uint8Array(
    await (await fetch(config.origin + '/bytes', { headers: pageHeaders })).arrayBuffer()
  )
  expect(Array.from(bytes)).toEqual(Array.from(comparisonChunk(0)))
  expect(
    (
      await fetch(config.origin + '/renderer', {
        method: 'POST',
        headers: { ...pageHeaders, origin: 'http://127.0.0.1:1' },
        body: JSON.stringify(data.renderer),
      })
    ).status
  ).toBe(403)
  expect(
    (
      await fetch(config.origin + '/renderer', {
        method: 'POST',
        headers: pageHeaders,
        body: JSON.stringify(data.renderer),
      })
    ).status
  ).toBe(200)
  expect(await completion).toEqual(data)
  const next = value.expect(1)
  expect((await fetch(config.origin + '/descriptor', { headers: pageHeaders })).status).toBe(425)
  value.edit(1)
  expect(await (await fetch(config.origin + '/command', { headers: hostHeaders })).json()).toEqual({
    action: 'edit',
    revision: 1,
  })
  expect(await (await fetch(config.origin + '/command', { headers: hostHeaders })).json()).toEqual({
    action: 'wait',
  })
  await value.close()
  await expect(next).rejects.toThrow('closed')
})
test('changed backend acknowledgment cannot be replaced with a stale controller revision', async () => {
  const value = await probe(),
    config = value.configuration,
    completion = value.expect(0)
  expect(
    (
      await fetch(config.origin + '/host', {
        method: 'POST',
        headers: { 'x-bunly-probe-token': config.hostToken },
        body: JSON.stringify(host('bunly', 1)),
      })
    ).status
  ).toBe(422)
  await expect(completion).rejects.toThrow('validation')
})

/** This deterministic renderer-unit harness is not a native/browser qualification adapter. */
async function rendererUnit(start: number, finish: number, storage: Map<string, string>) {
  const script = await readFile(
    resolve(import.meta.dir, '../benchmarks/fixtures/managed-comparison/client.js'),
    'utf8'
  )
  const completions: ReturnType<typeof comparisonRenderer>[] = []
  const form = { value: '', dispatchEvent() {} },
    output = { textContent: '' }
  let current = start
  class Terminal {
    text = ''
    open() {}
    write(text: string, done: () => void) {
      this.text += text
      done()
    }
    get buffer() {
      const lines = this.text
        .replaceAll(String.fromCharCode(27) + '[32m', '')
        .replaceAll(String.fromCharCode(27) + '[0m', '')
        .split('\r\n')
      return {
        active: {
          length: lines.length,
          getLine: (index: number) => ({ translateToString: () => lines[index] ?? '' }),
        },
      }
    }
  }
  // Await the same renderer body here without making the actual browser module wait for it.
  const unitEntry = script.replace('void runComparison()', 'return runComparison()')
  expect(unitEntry).not.toBe(script)
  const work = runInNewContext(`(async () => {${unitEntry}\n})()`, {
    Terminal,
    crypto: { randomUUID },
    TextEncoder,
    URLSearchParams,
    AbortSignal,
    Event,
    location: { hash: '#token=' + 'a'.repeat(48) },
    history: { replaceState() {} },
    document: { querySelector: (selector: string) => (selector === '#form' ? form : output) },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout,
    fetch: async (path: string, options: { body?: string }) => {
      if (path === '/descriptor')
        return current > finish
          ? new Response(null, { status: 410 })
          : Response.json({
              revision: current,
              storageKey: 'test-key',
              initialForm: current === 0 ? COMPARISON_FORM : null,
            })
      if (path === '/bytes') return new Response(Buffer.from(comparisonChunk(current)))
      if (path === '/renderer') {
        completions.push(comparisonRenderer(JSON.parse(options.body!), current))
        current++
        return Response.json({ accepted: true })
      }
      throw new Error('Unexpected renderer fixture request')
    },
  }) as Promise<void>
  await work
  return completions
}
test('actual shared renderer code preserves one document and restores later reference documents from prior browser storage', async () => {
  const retained = await rendererUnit(0, 4, new Map())
  expect(retained).toHaveLength(5)
  expect(new Set(retained.map((value) => value.document)).size).toBe(1)
  expect(retained.every((value) => !value.restored)).toBe(true)
  const storage = new Map<string, string>(),
    reconstructed: typeof retained = []
  for (let revision = 0; revision <= 4; revision++)
    reconstructed.push(...(await rendererUnit(revision, revision, storage)))
  expect(new Set(reconstructed.map((value) => value.document)).size).toBe(5)
  expect(reconstructed.map((value) => value.restored)).toEqual([false, true, true, true, true])
  expect(reconstructed.map((value) => [value.form, value.bytes, value.checksum])).toEqual(
    retained.map((value) => [value.form, value.bytes, value.checksum])
  )
})
test('actual shared renderer refuses missing prior form/output rather than reseeding state on relaunch', async () => {
  await expect(rendererUnit(1, 1, new Map())).rejects.toThrow('state was lost')
  const storage = new Map<string, string>()
  await rendererUnit(0, 0, storage)
  const key = [...storage.keys()][0]!,
    old = JSON.parse(storage.get(key)!) as Record<string, unknown>
  storage.set(key, JSON.stringify({ ...old, transcript: '' }))
  await expect(rendererUnit(1, 1, storage)).rejects.toThrow()
})

/** Synthetic receipt fixture only for independent-validator mutation tests. */
function reportFixture(): Record<string, unknown> {
  const engine = {
    event: 'cef-binary-identity',
    schema: 1,
    sha256: 'a'.repeat(64),
    cefVersion: '156.0.7',
    chromiumVersion: '156.0.1.2',
    cefCommitNumber: 1,
    fullVersion: null,
    source: 'exported-api',
    sandbox: 'unverified',
  }
  const processObservation = () => ({
    schema: 1,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    outputOverflow: false,
    cleanupSurvivors: [],
    observedOrphans: [],
    elapsedMs: 10,
    peakTreeRssBytes: 1,
    peakTreeThreads: 1,
    stdoutTail: [] as string[],
    stderr: [] as string[],
    environment: { os: 'Darwin' },
    samples: [{ processes: [{ pid: 100 }] }],
  })
  const phases = ['process-stop', 'host-release', 'asset-service-stop', 'cef-shutdown'].flatMap(
    (phase, index) => [
      { event: 'bunly.host.shutdown-phase', phase, state: 'start' },
      ...(index === 0 ? [{ event: 'bunly.backend.exit', code: 0, forced: false }] : []),
      { event: 'bunly.host.shutdown-phase', phase, state: 'complete', durationMs: 1 },
    ]
  )
  const native = {
    ...processObservation(),
    stderr: [...phases, { event: 'bunly.host.shutdown', clean: true }].map((event) =>
      JSON.stringify(event)
    ),
    postExitCleanup: {
      schema: 1,
      profile: 'macos-verified-code-sign-clone-v1',
      passed: true,
      qualified: true,
      status: 'completed',
      elapsedMs: 1,
      limitMs: 3000,
      observedClones: 1,
      cloneInventory: {
        prelaunchEntries: 0,
        entryLimit: 256,
        scope: 'new-names-after-prelaunch-snapshot',
      },
      helpers: [
        {
          pid: 101,
          creationTime: 1,
          role: 'code-sign-clone-cleanup',
          ownership: 'observed-root-child-and-matching-clone-inode',
          executableSha256: 'b'.repeat(64),
          processExited: true,
          cloneRemoved: true,
          completed: true,
        },
      ],
    },
  }
  const frameworks = (['bunly', 'electrobun', 'mirin'] as const).map((name) => {
    const commands: { phase: string; report: string; observation: unknown }[] = []
    for (let index = 0; index < (name === 'bunly' ? 1 : 5); index++) {
      if (name !== 'bunly')
        commands.push({
          phase: 'build',
          report: '000-build.json',
          observation: processObservation(),
        })
      commands.push({
        phase: 'app',
        report: '001-app.json',
        observation: name === 'bunly' ? native : processObservation(),
      })
    }
    commands.push({
      phase: 'cef-identity',
      report: '002-cef-identity.json',
      observation: { ...processObservation(), stdoutTail: [JSON.stringify(engine)] },
    })
    for (const [ordinal, command] of commands.entries())
      command.report = `${String(ordinal).padStart(3, '0')}-${command.phase}.json`
    const packaged = { entries: [{ path: 'CEF', kind: 'file', bytes: 1, sha256: engine.sha256 }] }
    return {
      framework: name,
      passed: true,
      failure: null,
      retainedFixture: false,
      processSandbox: 'unverified',
      engine,
      engineLibrary: 'CEF',
      acceptance: null,
      rows: rows(name),
      commands,
      rendererAssets: Object.fromEntries(
        ['html', 'javascript', 'terminalJs', 'terminalCss'].map((key) => [
          key,
          { bytes: 10, sha256: 'c'.repeat(64) },
        ])
      ),
      installation:
        name === 'electrobun'
          ? {
              version: '2.0.3-beta.26',
              manifestSha256: 'd'.repeat(64),
              bootstrapSha256: 'e'.repeat(64),
            }
          : name === 'mirin'
            ? {
                sourceVerified: false,
                lockSha256: 'f'.repeat(64),
                packages: ['mirinjs', '@mirinjs/cli'].map((packageName) => ({
                  name: packageName,
                  version: '0.1.0-alpha.26',
                  entrySha256: 'd'.repeat(64),
                  manifestSha256: 'e'.repeat(64),
                })),
              }
            : null,
      artifacts:
        name === 'bunly'
          ? {
              nativeCopies: 1,
              nativeCompilations: 0,
              originalUnchanged: true,
              preparedUnchanged: true,
              prepared: packaged,
            }
          : packaged,
    }
  })
  const source = { clean: true, commit: 'a'.repeat(40) },
    hashes = ['index.html', 'client.js'].map((name) => ({
      path: `benchmarks/fixtures/managed-comparison/${name}`,
      sha256: 'c'.repeat(64),
    }))
  return {
    schema: 1,
    profile: MANAGED_COMPARISON_PROFILE,
    passed: true,
    performanceEligible: false,
    runClass: 'local-smoke',
    target: 'darwin-arm64',
    bun: '1.4.4',
    plan: COMPARISON_PLAN,
    sourceBefore: source,
    sourceAfter: source,
    sourceHashes: hashes,
    sourceHashesAfter: hashes,
    nativeSource: { declaredCommit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    frameworks,
  }
}
test('independent replay recomputes outcome and refuses incompatible assets, false engine metadata and missing lifecycle evidence', () => {
  expect(acceptManagedComparisonReport(reportFixture())).toMatchObject({
    passed: true,
    performanceEligible: false,
  })
  const object = (value: unknown) => value as Record<string, unknown>
  for (const mutate of [
    (report: Record<string, unknown>) => {
      report['performanceEligible'] = true
    },
    (report: Record<string, unknown>) => {
      report['plan'] = { ...COMPARISON_PLAN, measurements: 2 }
    },
    (report: Record<string, unknown>) => {
      const framework = object((report['frameworks'] as unknown[])[1])
      object(object(framework['rendererAssets'])['javascript'])['sha256'] = '0'.repeat(64)
    },
    (report: Record<string, unknown>) => {
      const framework = object((report['frameworks'] as unknown[])[1])
      framework['engine'] = { ...object(framework['engine']), cefVersion: '157.0.1' }
    },
    (report: Record<string, unknown>) => {
      const framework = object((report['frameworks'] as unknown[])[0])
      object(object((framework['commands'] as unknown[])[0])['observation'])['stderr'] = []
    },
    (report: Record<string, unknown>) => {
      const framework = object((report['frameworks'] as unknown[])[2])
      ;(framework['commands'] as unknown[]).pop()
    },
    (report: Record<string, unknown>) => {
      const framework = object((report['frameworks'] as unknown[])[2])
      object((framework['rows'] as unknown[])[1])['status'] = 'failed'
    },
  ]) {
    const report = reportFixture()
    mutate(report)
    expect(() => acceptManagedComparisonReport(report)).toThrow()
  }
})
