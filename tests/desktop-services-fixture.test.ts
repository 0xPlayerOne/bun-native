import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  BunlyError,
  validateClipboardText,
  type OperationOptions,
  type PolicyScope,
} from '../packages/contracts/src/index.ts'
import type { NativeCapabilityGrant } from '../packages/runtime/src/cef.ts'
import {
  hasBunlyCode,
  qualifyClipboardText,
} from '../examples/desktop-services/clipboard-fixture.ts'
import { requireDisposableClipboardRunner } from '../scripts/cef-desktop-services-precondition.ts'

function fixture(initial: string | null, initialOtherFormat = false) {
  const scope = Object.freeze({}) as PolicyScope
  let text = initial,
    otherFormat = initialOtherFormat,
    read = false,
    write = false,
    writes = 0,
    clears = 0,
    failAfterWrite = false
  const check = (actual: PolicyScope, granted: boolean, options?: OperationOptions) => {
    assert.equal(actual, scope)
    options?.signal?.throwIfAborted()
    if (!granted) throw new BunlyError('PERMISSION_DENIED', 'Fixture authority denied')
  }
  return {
    scope,
    diagnostics: () => ({ text, otherFormat, writes, clears }),
    failAfterWrite: () => {
      failAfterWrite = true
    },
    backend: {
      async grantNativeCapability(actual: PolicyScope, capability: NativeCapabilityGrant) {
        assert.equal(actual, scope)
        if (capability.name === 'clipboard-read') read = true
        else if (capability.name === 'clipboard-write') write = true
        else throw new Error('Unexpected fixture capability')
      },
      async qualifyClipboardEmpty(actual: PolicyScope, options?: OperationOptions) {
        check(actual, read, options)
        return text === null && !otherFormat
      },
      async readClipboardText(actual: PolicyScope, options?: OperationOptions) {
        check(actual, read, options)
        return text
      },
      async writeClipboardText(actual: PolicyScope, value: string, options?: OperationOptions) {
        check(actual, write, options)
        validateClipboardText(value)
        writes++
        text = value
        otherFormat = false
        if (failAfterWrite) throw new Error('Injected receipt failure after mutation')
      },
      async clearClipboard(actual: PolicyScope, options?: OperationOptions) {
        check(actual, write, options)
        clears++
        text = null
        otherFormat = false
      },
    },
  }
}

test('desktop fixture errors retain their public brand across separate application bundles', () => {
  class SeparatelyBundledError extends Error {
    readonly code = 'PERMISSION_DENIED'
    constructor() {
      super('Scope denied')
      this.name = 'BunlyError'
    }
  }
  const error = new SeparatelyBundledError()
  assert.equal(error instanceof BunlyError, false)
  assert.equal(hasBunlyCode('PERMISSION_DENIED')(error), true)
  for (const value of [
    null,
    new Error('PERMISSION_DENIED'),
    { code: 'PERMISSION_DENIED' },
    { name: 'BunlyError', code: 'INVALID_ARGUMENT' },
  ])
    assert.equal(hasBunlyCode('PERMISSION_DENIED')(value), false)
})

test('clipboard contributor fixture refuses text, empty-string and non-text user contents before any write or clear', async () => {
  for (const [text, other] of [
    ['existing data', false],
    ['', false],
    [null, true],
  ] as const) {
    const f = fixture(text, other)
    await assert.rejects(
      qualifyClipboardText(f.backend, f.scope, new AbortController().signal),
      /requires an empty disposable clipboard/
    )
    assert.deepEqual(f.diagnostics(), { text, otherFormat: other, writes: 0, clears: 0 })
  }
})

test('clipboard contributor fixture restores initial emptiness after success or a failed mutation receipt', async () => {
  const f = fixture(null)
  const receipt = await qualifyClipboardText(f.backend, f.scope, new AbortController().signal)
  assert.equal(receipt.restoredEmpty, true)
  assert.equal(receipt.emptyStringDistinct, true)
  assert.ok(Object.values(receipt).every((value) => value === true || value === 'executed'))
  assert.deepEqual(f.diagnostics(), { text: null, otherFormat: false, writes: 4, clears: 2 })
  const failed = fixture(null)
  failed.failAfterWrite()
  await assert.rejects(
    qualifyClipboardText(failed.backend, failed.scope, new AbortController().signal),
    /Injected receipt failure/
  )
  assert.deepEqual(failed.diagnostics(), { text: null, otherFormat: false, writes: 1, clears: 1 })
})

test('outer clipboard qualification precondition rejects local, self-hosted and accidental runs before native launch', () => {
  const mac = {
    optIn: '--disposable-clipboard',
    platform: 'darwin',
    arch: 'arm64',
    environment: {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      GITHUB_RUN_ID: '12345',
      RUNNER_OS: 'macOS',
    },
  }
  assert.equal(requireDisposableClipboardRunner(mac), 'darwin-arm64')
  assert.equal(
    requireDisposableClipboardRunner({
      ...mac,
      platform: 'win32',
      arch: 'x64',
      environment: { ...mac.environment, RUNNER_OS: 'Windows' },
    }),
    'win32-x64'
  )
  for (const options of [
    { ...mac, optIn: undefined },
    { ...mac, environment: {} },
    { ...mac, environment: { ...mac.environment, GITHUB_ACTIONS: 'false' } },
    { ...mac, environment: { ...mac.environment, RUNNER_ENVIRONMENT: 'self-hosted' } },
    { ...mac, environment: { ...mac.environment, GITHUB_RUN_ID: 'invalid' } },
    { ...mac, environment: { ...mac.environment, RUNNER_OS: 'Windows' } },
    { ...mac, platform: 'linux', arch: 'x64' },
  ])
    assert.throws(() => requireDisposableClipboardRunner(options), /disposable/)
})
