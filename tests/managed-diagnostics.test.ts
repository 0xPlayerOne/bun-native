import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedDiagnostics } from '../examples/managed-desktop/diagnostics.ts'
import { DevelopmentSession } from '../packages/cli/src/dev-host.ts'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import { ServiceReloadError, ServiceReloadHost } from '../packages/runtime/src/service-reload.ts'

test('retained broker detail preserves the first-line cause without local paths or stacks', () => {
  for (const path of [
    '/Users/private person/checkout/service.ts',
    'C:\\Users\\private person\\checkout\\service.ts',
    '\\\\private-server\\private-share\\service.ts',
    'file:///workspace/private-checkout/service.ts',
  ]) {
    const diagnostics = new ManagedDiagnostics()
    diagnostics.broker({
      event: 'failure',
      generation: 1,
      stage: 'prepare',
      elapsedMs: 4,
      code: 'PREPARE_FAILED',
      restartRequired: false,
      detail: `Error: Cannot initialize the service at ${path}\n    at privateFunction (${path}:4:9)`,
    })
    const record = diagnostics.snapshot().entries[0]!
    expect(record).toMatchObject({
      source: 'broker',
      stage: 'prepare',
      code: 'PREPARE_FAILED',
      restartRequired: false,
      detail: {
        text: 'Error: Cannot initialize the service at [local path omitted]',
        redacted: true,
        truncated: true,
      },
    })
    const output = JSON.stringify(diagnostics.snapshot())
    expect(output).not.toContain('private')
    expect(output).not.toContain('service.ts')
    expect(output).not.toContain('privateFunction')
  }
})

test('public diagnostic text redacts credential and opaque values and explicitly bounds text', () => {
  for (const detail of [
    'Error: Authority rejected token=very-private-credential',
    'Error: Authority rejected nonce="very-private-credential"',
    'Error: Authority rejected Authorization: Bearer very-private-credential',
  ]) {
    const diagnostics = new ManagedDiagnostics()
    diagnostics.failure('bindings', new Error(detail))
    const message = diagnostics.snapshot().entries[0]!.message!
    expect(message.text).toBe('Error: Authority rejected [sensitive value omitted]')
    expect(message.redacted).toBe(true)
    expect(message.truncated).toBe(true)
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('very-private-credential')
  }
  const diagnostics = new ManagedDiagnostics()
  diagnostics.failure('fixture', new Error('Owner 11111111-2222-3333-4444-555555555555 rejected'))
  expect(diagnostics.snapshot().entries[0]!.message).toEqual({
    text: 'Owner [opaque token omitted] rejected',
    redacted: true,
    truncated: false,
  })
  diagnostics.failure('fixture', new Error('Worker detail '.repeat(1000)))
  expect(diagnostics.snapshot().entries[1]!.message!.text.length).toBe(512)
  expect(diagnostics.snapshot().entries[1]!.message!.truncated).toBe(true)
  diagnostics.failure('fixture', new Error('at sensitiveFrame (C:\\private\\service.ts:1:1)'))
  expect(diagnostics.snapshot().entries[2]!.message!.text).toBe('[stack frame omitted]')
})

test('ordinary replacement stages are ignored and failure retention is bounded with a drop count', () => {
  const diagnostics = new ManagedDiagnostics()
  for (let generation = 1; generation <= 500; generation++) {
    diagnostics.broker({ event: 'stage', stage: 'prepare', generation, elapsedMs: 0 })
    diagnostics.development({
      schema: 1,
      event: 'reload',
      stage: 'replace',
      sequence: generation,
      durationMs: 1,
      code: 'RELOADED',
      restartRequired: false,
      message: 'Replacement is ready',
    })
  }
  expect(diagnostics.snapshot()).toEqual({ schema: 1, entries: [], dropped: 0 })
  for (let count = 0; count < 100; count++)
    diagnostics.failure('fixture', new Error(`Failure ${count}: ${'bounded detail '.repeat(100)}`))
  const snapshot = diagnostics.snapshot()
  expect(snapshot.entries).toHaveLength(32)
  expect(snapshot.dropped).toBe(68)
  expect(JSON.stringify(snapshot).length).toBeLessThan(24 * 1024)
  diagnostics.failure('fixture', new Error('Later failure'))
  expect(snapshot.dropped).toBe(68)
  expect(diagnostics.snapshot().dropped).toBe(69)
})

test('binding and typed reload observations preserve the exact original rejection', async () => {
  const diagnostics = new ManagedDiagnostics()
  const binding = Object.assign(new Error('Native authority is stale'), { code: 'STALE' })
  await expect(
    diagnostics.observe('bindings', async () => {
      throw binding
    })
  ).rejects.toBe(binding)
  expect(diagnostics.snapshot().entries[0]).toMatchObject({
    source: 'bindings',
    stage: 'bindings',
    code: 'STALE',
    message: { text: 'Native authority is stale', redacted: false, truncated: false },
  })
  const reload = new ServiceReloadError(
    'PREPARE_FAILED',
    'prepare',
    false,
    'Error: Worker import rejected at C:\\private\\runner.ts\n    at internalFrame'
  )
  await expect(
    diagnostics.observe('reload', async () => {
      throw reload
    })
  ).rejects.toBe(reload)
  expect(diagnostics.snapshot().entries[1]).toMatchObject({
    source: 'reload',
    stage: 'prepare',
    code: 'PREPARE_FAILED',
    candidateRetired: true,
    committed: false,
    detail: {
      text: 'Error: Worker import rejected at [local path omitted]',
      redacted: true,
      truncated: true,
    },
  })
  const unexpected = Object.defineProperty(new Error('Original rejection'), 'code', {
    get() {
      throw new Error('Getter must not replace the rejection')
    },
  })
  await expect(
    diagnostics.observe('bindings', async () => {
      throw unexpected
    })
  ).rejects.toBe(unexpected)
  expect(diagnostics.snapshot().dropped).toBe(1)
})

test('actual Worker startup failure retains its sanitized cause beneath the DevelopmentSession wrapper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-managed-diagnostic-'))
  const diagnostics = new ManagedDiagnostics()
  const owner = new ManagedGenerationOwner()
  const broker = new ServiceReloadHost({
    owner,
    stateSchema: 'diagnostic:1',
    permissions: [],
    mechanism: 'worker',
    readyTimeoutMs: 2000,
    onDiagnostic: (event) => diagnostics.broker(event),
  })
  try {
    await mkdir(join(root, 'backend'))
    await writeFile(
      join(root, 'backend/service.ts'),
      `export default () => { throw new Error(${JSON.stringify(`Worker initializer rejected at ${join(root, 'private-service.ts')}\n    at privateFrame`)}) }`
    )
    let wrapper: unknown
    try {
      await DevelopmentSession.start({
        projectRoot: root,
        entrypoint: 'backend/service.ts',
        backendRoots: ['backend'],
        cacheRoot: '.cache',
        watch: false,
        reload: (bundle) =>
          diagnostics.observe('reload', () => broker.reload({ entry: bundle.entry })),
        shutdown: () => broker.close(),
        onDiagnostic: (event) => diagnostics.development(event),
      })
    } catch (error) {
      wrapper = error
      diagnostics.failure('fixture', error)
    }
    expect(wrapper).toMatchObject({ code: 'BUILD_FAILED' })
    const result = diagnostics.snapshot()
    expect(
      result.entries.some((entry) => entry.source === 'broker' && entry.code === 'PREPARE_FAILED')
    ).toBe(true)
    expect(result.entries.find((entry) => entry.source === 'reload')).toMatchObject({
      stage: 'prepare',
      code: 'PREPARE_FAILED',
      candidateRetired: true,
      committed: false,
      detail: {
        text: 'Error: Worker initializer rejected at [local path omitted]',
        redacted: true,
        truncated: true,
      },
    })
    expect(result.entries.find((entry) => entry.source === 'development')).toMatchObject({
      stage: 'replace',
      code: 'PREPARE_FAILED',
    })
    expect(result.entries.find((entry) => entry.source === 'fixture')).toMatchObject({
      code: 'BUILD_FAILED',
    })
    const retained = join(root, 'diagnostics.json')
    await writeFile(retained, JSON.stringify(result))
    const publicText = await readFile(retained, 'utf8')
    expect(publicText).not.toContain(root)
    expect(publicText).not.toContain('private-service.ts')
    expect(publicText).not.toContain('privateFrame')
    expect(broker.diagnostics().generations).toBe(0)
    expect(owner.diagnostics().generations).toBe(0)
  } finally {
    await broker.close()
    owner.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('actual Bun bundle rejection is retained without misreporting a broker initialization failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-managed-diagnostic-build-'))
  const diagnostics = new ManagedDiagnostics()
  let reloads = 0
  try {
    await mkdir(join(root, 'backend'))
    await writeFile(join(root, 'backend/service.ts'), 'export default (')
    await expect(
      DevelopmentSession.start({
        projectRoot: root,
        entrypoint: 'backend/service.ts',
        backendRoots: ['backend'],
        cacheRoot: '.cache',
        watch: false,
        reload: async () => {
          reloads++
        },
        shutdown: async () => {},
        onDiagnostic: (event) => diagnostics.development(event),
      })
    ).rejects.toMatchObject({ code: 'BUILD_FAILED' })
    expect(reloads).toBe(0)
    expect(diagnostics.snapshot().entries[0]).toMatchObject({
      source: 'development',
      stage: 'bundle',
      code: 'BUILD_FAILED',
    })
    expect(diagnostics.snapshot().entries.some((entry) => entry.source === 'broker')).toBe(false)
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
