import { createApplication, type InputState } from '@bun-native/core'
import { inputState, render, type RenderRoot, type SolidNode } from '@bun-native/solid'
import { createSignal, onCleanup } from 'solid-js'
import { resolve } from 'node:path'
import { recordEvidence } from '../../examples/native-window/content.ts'

const executable = process.env['BUN_NATIVE_HOST']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
if (!executable || !nonce)
  throw new Error('Use the owned native-input harness with a prebuilt host')
const application = await createApplication({ executable: resolve(executable) })
const complete = `Solid ${nonce}`
let view: RenderRoot | undefined
let input: SolidNode | undefined
let preserved = false
let replaced = false
let cleaned = false

try {
  const window = await application.openWindow({
    title: 'Bun Native Solid Input',
    width: 640,
    height: 380,
  })
  view = render(() => {
    const [value, setValue] = createSignal<InputState>({ value: '', revision: 0 })
    onCleanup(() => {
      cleaned = true
    })
    return (
      <box style={{ direction: 'column', gap: 12, padding: 24 }}>
        <text text="Solid input revision contract" />
        <input
          ref={(node) => {
            input = node
          }}
          value={value()}
          style={{ width: 'fill', font_size: 24 }}
          onInput={async (event) => {
            recordEvidence({
              type: 'input',
              sequence: event.sequence,
              input_revision: event.revision,
              value: event.value,
            })
            if (event.revision === 1) {
              // OS typing continues while the first Solid callback is suspended.
              const deadline = performance.now() + 1_000
              while (inputState(input!).revision === event.revision && performance.now() < deadline)
                await Bun.sleep(1)
              const newer = inputState(input!)
              if (newer.revision <= event.revision)
                throw new Error('No concurrent native edit observed')
              setValue(event)
              await view!.flush()
              const after = inputState(input!)
              if (after.revision < newer.revision || !after.value.startsWith(newer.value))
                throw new Error('An old Solid event echo overwrote a newer native edit')
              preserved = true
              recordEvidence({
                type: 'solid-stale-echo-preserved',
                event_revision: event.revision,
                before: newer,
                after,
              })
            } else {
              setValue(event)
            }
            if (event.value === complete) {
              const observed = inputState(input!)
              const intent = { value: 'Explicit replacement', revision: observed.revision }
              setValue(intent)
              await view!.flush()
              const after = inputState(input!)
              if (after.value !== intent.value || after.revision !== intent.revision + 1)
                throw new Error(
                  'Explicit Solid value intent was not acknowledged at its expected revision'
                )
              replaced = true
              recordEvidence({ type: 'solid-value-intent-applied', submitted: intent, after })
            }
          }}
        />
        <text text={`Revision: ${value().revision}`} />
      </box>
    )
  }, window)
  await view.ready
  await window.closed
  await view.dispose()
  if (
    !preserved ||
    !replaced ||
    !cleaned ||
    view.diagnostics.nodes !== 0 ||
    view.diagnostics.listeners !== 0
  )
    throw new Error('Solid input revision/lifetime fixture did not complete')
  recordEvidence({
    type: 'solid-input-complete',
    preserved,
    replaced,
    cleaned,
    diagnostics: view.diagnostics,
  })
  recordEvidence({ type: 'closed' })
} finally {
  await view?.dispose()
  await application.shutdown()
  await application.closed
}
