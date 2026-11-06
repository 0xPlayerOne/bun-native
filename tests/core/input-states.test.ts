import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  UnsupportedFeatureError,
  type NativeApplication,
} from '@bun-native/core'
import { parseElement } from '@bun-native/protocol'
import { createElement, setProperty } from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function withApp(mode: string, run: (app: NativeApplication) => Promise<void>) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'protocol-peer.ts'), mode],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
}

describe('disabled and read-only input states (headless)', () => {
  test('the shared parser carries only true states and rejects non-boolean values', () => {
    expect(parseElement({ kind: 'input', value: 'a', disabled: false, read_only: false })).toEqual({
      kind: 'input',
      value: 'a',
      placeholder: '',
      style: {},
    })
    expect(parseElement({ kind: 'input', value: 'a', disabled: true, read_only: true })).toEqual({
      kind: 'input',
      value: 'a',
      placeholder: '',
      disabled: true,
      read_only: true,
      style: {},
    })
    for (const element of [
      { kind: 'input', value: '', disabled: 'true' },
      { kind: 'input', value: '', read_only: 1 },
      { kind: 'input', value: '', readOnly: true },
    ])
      expect(() => parseElement(element)).toThrow()
  })

  test('a host without input_states_v1 rejects the state locally before any command', () =>
    withApp('normal', async (app) => {
      expect(app.capabilities).not.toContain('input_states_v1')
      const window = await app.openWindow({ title: 'No input states' })
      for (const [state, feature] of [
        [{ read_only: true }, 'input:read_only'],
        [{ disabled: true }, 'input:disabled'],
      ] as const)
        await assert.rejects(
          window.batch((batch) => batch.create({ kind: 'input', value: '', ...state })),
          (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === feature
        )
      expect(window.revision).toBe(0)
      // Ordinary inputs and explicit false states still work.
      await window.batch((batch) =>
        batch.append(window.root, batch.create({ kind: 'input', value: '', disabled: false }))
      )
      expect(window.revision).toBe(1)
    }))

  test('an advertising host accepts creation and revision-checked state changes', () =>
    withApp('input-states', async (app) => {
      expect(app.capabilities).toContain('input_states_v1')
      const window = await app.openWindow({ title: 'Input states' })
      const input = await window.batch((batch) => {
        const node = batch.create({ kind: 'input', value: 'copy me', read_only: true })
        batch.append(window.root, node)
        return node
      })
      const current = window.input(input)
      await window.batch((batch) =>
        batch.set(input, { kind: 'input', value: current.value, disabled: true }, current.revision)
      )
      expect(window.input(input)).toEqual({ value: 'copy me', revision: current.revision + 1 })
    }))

  test('renderer props map disabled and readOnly to inputs only', () => {
    const input = createElement('input')
    setProperty(input, 'disabled', true)
    setProperty(input, 'readOnly', true)
    expect(input.properties).toEqual({ disabled: true, readOnly: true })
    expect(() => setProperty(input, 'readOnly', 'yes')).toThrow('boolean')
    expect(() => setProperty(createElement('button'), 'readOnly', true)).toThrow('Only inputs')
    expect(() => setProperty(createElement('text'), 'disabled', true)).toThrow()
    setProperty(input, 'readOnly', undefined)
    setProperty(input, 'disabled', undefined)
    expect(input.properties).toEqual({})
  })
})
