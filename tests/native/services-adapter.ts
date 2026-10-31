/** One native service and lifecycle oracle shared by the two framework fixtures. */
import {
  createApplication,
  NativeStateError,
  type ClickEvent,
  type NativeDisplaySnapshot,
  type NativeWindow,
} from '@bun-native/core'
import type { RenderRoot } from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { recordEvidence } from '../../examples/native-window/content.ts'

type Mount = (
  window: NativeWindow,
  readDisplay: (event: ClickEvent) => Promise<string>,
  ownerDisposed: () => void
) => { view: RenderRoot; markReady(): void }

export async function runServiceAdapter(framework: 'solid' | 'react', mount: Mount) {
  const configuredHost = process.env['BUN_NATIVE_HOST']
  if (!configuredHost) throw new Error('Set BUN_NATIVE_HOST to an explicit prebuilt native host')
  const app = await createApplication({
    executable: resolve(configuredHost),
    permissions: { windowDisplay: 'allow' },
  })
  let view: RenderRoot | undefined
  let failure: Error | undefined
  let activations = 0
  let ownerDisposals = 0
  let staleOwnerRejected = false
  let snapshot: NativeDisplaySnapshot | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    assert.equal(app.serviceCapabilities.windowDisplay.permission, 'allow')
    assert.equal(app.serviceCapabilities.clipboardText.availability, 'unavailable')
    const window = await app.openWindow({
      title: 'Bun Native desktop services',
      width: 560,
      height: 380,
    })
    const mounted = mount(
      window,
      async (event) => {
        assert.equal(++activations, 1)
        assert(event.sequence > 0)
        snapshot = await window.displaySnapshot({ signal: event.signal })
        assert(Object.isFrozen(snapshot))
        assert(Object.isFrozen(snapshot.bounds))
        recordEvidence({
          type: 'click',
          target: 'window-display',
          framework,
          sequence: event.sequence,
          snapshot,
        })
        return `Display: ${snapshot.bounds.width}x${snapshot.bounds.height} @${snapshot.scaleFactor}`
      },
      () => ownerDisposals++
    )
    view = mounted.view
    await view.ready
    // The driver targets this second complete paint. The initial framework
    // mount and its stable click binding have already been published.
    mounted.markReady()
    await view.flush()
    assert.equal(window.revision, 2)
    recordEvidence({ type: 'service-adapter-ready', framework, diagnostics: view.diagnostics })
    await Promise.race([
      window.closed,
      view.closed,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Native service adapter deadline expired')),
          45_000
        )
      }),
    ])
    await assert.rejects(
      window.displaySnapshot(),
      (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
    )
    staleOwnerRejected = true
    assert.equal(activations, 1)
    await view.dispose()
    assert.equal(ownerDisposals, 1)
    assert.equal(view.diagnostics.nodes, 0)
    assert.equal(view.diagnostics.listeners, 0)
    assert.equal(view.diagnostics.pending, false)
  } catch (cause) {
    failure = cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    clearTimeout(deadline)
    const capture = async (operation: Promise<unknown> | undefined) => {
      try {
        await operation
      } catch (cause) {
        failure ??= cause instanceof Error ? cause : new Error(String(cause))
      }
    }
    await capture(view?.dispose())
    await capture(app.shutdown())
    await capture(app.closed)
    if (!Object.values(app.diagnostics).every((count) => count === 0))
      failure ??= new Error('Public service adapter ownership survived shutdown')
    const evidence = process.env['BUN_NATIVE_EVIDENCE_LOG']
    if (evidence)
      writeFileSync(
        join(dirname(evidence), 'service-adapter-result.json'),
        JSON.stringify(
          {
            status: failure ? 'failed' : 'passed',
            framework,
            activations,
            ownerDisposals,
            staleOwnerRejected,
            snapshot,
            ownership: app.diagnostics,
            renderer: view?.diagnostics,
            error: failure?.message,
          },
          null,
          2
        ) + '\n'
      )
  }
  if (failure) throw failure
}
