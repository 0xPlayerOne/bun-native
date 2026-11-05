/** Shared lifecycle for the portable public-framework fixtures; no simulated input. */
import {
  createApplication,
  type InputState,
  type NativeApplication,
  type NativeUIEvent,
  type NativeWindow,
} from '@bun-native/core'
import type { EventHandlers, RenderRoot } from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export interface PlatformAdapterState {
  label: string
  input: InputState
}
export const initialPlatformState: PlatformAdapterState = {
  label: 'Clicks: 0',
  input: { value: '', revision: 0 },
}
type PlatformHandlers = Required<
  Pick<
    EventHandlers,
    | 'onClick'
    | 'onInput'
    | 'onPointerDownCapture'
    | 'onPointerUpCapture'
    | 'onKeyDownCapture'
    | 'onKeyUpCapture'
    | 'onFocusCapture'
    | 'onBlurCapture'
  >
>
export type PlatformAdapterMount = (
  window: NativeWindow,
  handlers: PlatformHandlers,
  ownerDisposed: () => void
) => {
  view: RenderRoot
  input(): InputState
  update(state: PlatformAdapterState): void
}

export async function runPlatformAdapter(
  framework: 'solid' | 'react',
  mount: PlatformAdapterMount
): Promise<void> {
  const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
  const executable = process.env['BUN_NATIVE_HOST']
  const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
  if (!directory || !isAbsolute(directory) || !executable || !isAbsolute(executable) || !nonce)
    throw new Error('An explicit diagnostics directory, native host and nonce are required')
  const outputDirectory = directory
  const osInput = process.env['BUN_NATIVE_PLATFORM_INPUT'] === '1'
  const record = (type: string, fields: Record<string, unknown>) =>
    appendFileSync(
      join(directory, 'application.jsonl'),
      JSON.stringify({ nonce, type, framework, ...fields }) + '\n'
    )
  async function step(name: string): Promise<void> {
    const deadline = performance.now() + 10_000
    while (!existsSync(join(outputDirectory, name))) {
      if (existsSync(join(outputDirectory, 'abort')))
        throw new Error('Controller aborted native smoke')
      if (performance.now() > deadline) throw new Error('Controller did not request ' + name)
      await Bun.sleep(10)
    }
  }

  let app: NativeApplication | undefined
  let active: RenderRoot | undefined
  let failure: unknown
  let nativeShutdownAndExitVerified = false
  let completedCycles = 0
  let observedInputEvents = 0
  let ownerDisposals = 0
  const renderers: RenderRoot['diagnostics'][] = []
  const callbackSignals: AbortSignal[] = []
  const started = performance.now()
  try {
    app = await createApplication({ executable })
    for (let cycle = 1; cycle <= 3; cycle++) {
      const window: NativeWindow = await app.openWindow({
        title: 'Bun Native platform smoke ' + cycle,
        width: 560,
        height: 380,
      })
      const route = (event: NativeUIEvent) => {
        if (osInput)
          record('os-route', {
            cycle,
            event: event.type,
            kind: event.node.kind,
            sequence: event.sequence,
            treeRevision: event.treeRevision,
            ...('key' in event ? { key: event.key, modifiers: event.modifiers } : {}),
            ...('button' in event
              ? { button: event.button, x: event.x, y: event.y, modifiers: event.modifiers }
              : {}),
          })
      }
      const handlers: PlatformHandlers = {
        onClick(event) {
          observedInputEvents += 1
          callbackSignals.push(event.signal)
          if (osInput)
            record('os-click', {
              cycle,
              kind: event.node.kind,
              sequence: event.sequence,
              treeRevision: event.treeRevision,
            })
        },
        onInput(event) {
          observedInputEvents += 1
          callbackSignals.push(event.signal)
          if (osInput)
            record('os-input', {
              cycle,
              kind: event.node.kind,
              sequence: event.sequence,
              treeRevision: event.treeRevision,
              value: event.value,
              revision: event.revision,
            })
        },
        onPointerDownCapture: route,
        onPointerUpCapture: route,
        onKeyDownCapture: route,
        onKeyUpCapture: route,
        onFocusCapture: route,
        onBlurCapture: route,
      }
      const mounted = mount(window, handlers, () => ownerDisposals++)
      active = mounted.view
      await active.ready
      assert.equal(window.revision, 1)
      record('mounted', { cycle, treeRevision: window.revision, input: mounted.input() })
      await step('update-' + cycle)
      const before = mounted.input()
      assert.deepEqual(
        before,
        osInput ? { value: nonce, revision: nonce.length } : { value: '', revision: 0 }
      )
      const input: InputState = { value: `Native ${cycle} ${nonce}`, revision: before.revision }
      mounted.update({ label: 'Native update ' + cycle, input })
      await active.flush()
      assert.equal(window.revision, 2)
      assert.deepEqual(mounted.input(), { value: input.value, revision: before.revision + 1 })
      record('updated', { cycle, treeRevision: window.revision, input: mounted.input() })
      await step('close-' + cycle)
      await window.close()
      await window.closed
      await active.dispose()
      await active.closed
      assert.equal(ownerDisposals, cycle)
      assert.equal(active.diagnostics.nodes, 0)
      assert.equal(active.diagnostics.listeners, 0)
      assert.equal(active.diagnostics.pending, false)
      assert(callbackSignals.every((signal) => signal.aborted))
      assert(Object.values(app.diagnostics).every((count) => count === 0))
      renderers.push(active.diagnostics)
      active = undefined
      completedCycles += 1
      record('cycle-closed', { cycle, ownership: app.diagnostics, ownerDisposals })
    }
    assert.equal(
      observedInputEvents,
      osInput ? 3 * (1 + nonce.length) : 0,
      'Every requested native OS activation/edit must be observed exactly once'
    )
  } catch (error) {
    failure = error
  } finally {
    const capture = async (operation: Promise<unknown> | undefined) => {
      try {
        await operation
      } catch (error) {
        failure ??= error
      }
    }
    await capture(active?.dispose())
    if (app) {
      try {
        await app.shutdown()
        await app.closed
        nativeShutdownAndExitVerified = true
        assert(Object.values(app.diagnostics).every((count) => count === 0))
      } catch (error) {
        failure ??= error
      }
    }
  }
  const result = {
    status: failure ? 'failed' : 'passed',
    scenario: 'platform-smoke',
    framework,
    osInput,
    completedCycles,
    nativeShutdownAndExitVerified,
    ownership: app?.diagnostics,
    observedInputEvents,
    ownerDisposals,
    renderers,
    revokedInputCallbacks: callbackSignals.filter((signal) => signal.aborted).length,
    elapsedMs: performance.now() - started,
    error: failure instanceof Error ? { name: failure.name, message: failure.message } : failure,
  }
  writeFileSync(join(directory, 'application-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
  if (failure) process.exitCode = 1
}
