import { createApplication, type NativeApplication, type NativeWindow } from '@bun-native/core'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { INITIAL_ELEMENTS, mountContent } from '../../examples/native-window/content.ts'

// Public-core consumer. The external controller independently checks the real
// host's nonce-tagged paints; private files only sequence application mutations.
const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
const executable = process.env['BUN_NATIVE_HOST']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
if (!directory || !isAbsolute(directory) || !executable || !isAbsolute(executable) || !nonce)
  throw new Error('An explicit diagnostics directory, native host and nonce are required')
const outputDirectory = directory
const osInput = process.env['BUN_NATIVE_PLATFORM_INPUT'] === '1'
const record = (type: string, fields: Record<string, unknown>) =>
  appendFileSync(
    join(outputDirectory, 'application.jsonl'),
    JSON.stringify({ nonce, type, ...fields }) + '\n'
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
let failure: unknown
let nativeShutdownAndExitVerified = false
let completedCycles = 0
let observedInputEvents = 0
const started = performance.now()
try {
  app = await createApplication({ executable })
  for (let cycle = 1; cycle <= 3; cycle++) {
    const window: NativeWindow = await app.openWindow({
      title: 'Bun Native platform smoke ' + cycle,
      width: 560,
      height: 380,
    })
    const { label, button, input } = await mountContent(window)
    window.onClick(button, (event) => {
      observedInputEvents += 1
      if (osInput)
        record('os-click', {
          cycle,
          kind: event.node.kind,
          sequence: event.sequence,
          treeRevision: event.treeRevision,
        })
    })
    window.onInput(input, (event) => {
      observedInputEvents += 1
      if (osInput)
        record('os-input', {
          cycle,
          kind: event.node.kind,
          sequence: event.sequence,
          treeRevision: event.treeRevision,
          value: event.value,
          revision: event.revision,
        })
    })
    if (osInput) {
      for (const type of [
        'pointer_down',
        'pointer_up',
        'key_down',
        'key_up',
        'focus',
        'blur',
      ] as const)
        window.on(
          window.root,
          type,
          (event) => {
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
          },
          { capture: true }
        )
    }
    record('mounted', { cycle, treeRevision: window.revision, input: window.input(input) })
    await step('update-' + cycle)
    const before = window.input(input)
    assert.deepEqual(
      before,
      osInput ? { value: nonce, revision: nonce.length } : { value: '', revision: 0 }
    )
    const value: string = `Native ${cycle} ${nonce}`
    await window.batch((batch) => {
      batch.set(label, { kind: 'text', text: 'Native update ' + cycle })
      batch.set(input, { ...INITIAL_ELEMENTS[4], value }, before.revision)
    })
    assert.deepEqual(window.input(input), { value, revision: before.revision + 1 })
    record('updated', { cycle, treeRevision: window.revision, input: window.input(input) })
    await step('close-' + cycle)
    await window.close()
    await window.closed
    assert(Object.values(app.diagnostics).every((count) => count === 0))
    completedCycles += 1
    record('cycle-closed', { cycle, ownership: app.diagnostics })
  }
  assert.equal(
    observedInputEvents,
    osInput ? 3 * (1 + nonce.length) : 0,
    'Every requested native OS activation/edit must be observed exactly once'
  )
} catch (error) {
  failure = error
} finally {
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
  osInput,
  completedCycles,
  nativeShutdownAndExitVerified,
  ownership: app?.diagnostics,
  observedInputEvents,
  elapsedMs: performance.now() - started,
  error: failure instanceof Error ? { name: failure.name, message: failure.message } : failure,
}
writeFileSync(
  join(outputDirectory, 'application-result.json'),
  JSON.stringify(result, null, 2) + '\n'
)
console.log(JSON.stringify(result))
if (failure) process.exitCode = 1
