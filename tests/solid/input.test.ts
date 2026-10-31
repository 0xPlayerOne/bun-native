import { describe, expect, test } from 'bun:test'
import { NativeStateError, type InputEvent } from '@bun-native/core'
import {
  createElement,
  inputState,
  insert,
  render,
  setProp,
  type SolidNode,
} from '@bun-native/solid'
import assert from 'node:assert/strict'
import { observeWindow, withApp } from '../renderers/support.ts'

function content(input: SolidNode, text?: SolidNode) {
  const box = createElement('box')
  insert(box, text ? [input, text] : [input])
  return box
}

function inputNode() {
  const input = createElement('input')
  setProp(input, 'value', '')
  setProp(input, 'onInput', () => {})
  return input
}

describe('Solid input intents through the shared public core (headless subprocess)', () => {
  test('captures an explicit value/revision before awaiting and never replays it on style changes', () =>
    withApp(async (app) => {
      const actual = await app.openWindow({ title: 'Solid input replacement' })
      const { window, observations } = observeWindow(actual)
      const input = inputNode()
      const root = render(() => input, window)
      await root.ready
      const intent = { value: 'Submitted value', revision: inputState(input).revision }
      setProp(input, 'value', intent)
      intent.value = 'Mutation after submission'
      intent.revision = 999
      await root.flush()
      const handle = observations.inputs[0]!
      expect(actual.input(handle)).toEqual({ value: 'Submitted value', revision: 1 })
      expect(inputState(input)).toEqual({ value: 'Submitted value', revision: 1 })
      setProp(input, 'placeholder', 'Updated appearance')
      await root.flush()
      expect(actual.input(handle)).toEqual({ value: 'Submitted value', revision: 2 })
      setProp(input, 'value', undefined)
      const before = root.diagnostics
      await root.flush()
      expect(actual.input(handle)).toEqual({ value: 'Submitted value', revision: 2 })
      expect(root.diagnostics.commits).toBe(before.commits)
      await root.dispose()
      assert.throws(() => inputState(input), /mounted native input/)
    }))

  test('an explicit stale intent is rejected instead of being authorized with a newer revision', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid stale input' })
      const marker = await window.batch((batch) => {
        const node = batch.create({ kind: 'text', text: 'Marker' })
        batch.append(window.root, node)
        return node
      })
      const input = inputNode()
      const root = render(() => input, window)
      await root.ready
      const nativeEdit = window.batch((batch) =>
        batch.set(marker, { kind: 'text', text: 'input before acknowledgement' })
      )
      setProp(input, 'value', { value: 'Obsolete application text', revision: 0 })
      await nativeEdit
      await assert.rejects(
        root.flush(),
        (error: unknown) => error instanceof NativeStateError && error.code === 'stale_revision'
      )
      await assert.rejects(root.closed, /current observed revision/)
      // Only this view is removed; the caller's independent native marker remains.
      expect(app.diagnostics.nodes).toBe(2)
      expect(app.diagnostics.callbacks).toBe(0)
    }))

  test('an older actual native event echo emits no replacement after a newer edit is ingested', () =>
    withApp(async (app) => {
      const actual = await app.openWindow({ title: 'Solid native echo race' })
      const { window, observations } = observeWindow(actual)
      const input = inputNode()
      const text = createElement('text')
      setProp(text, 'text', 'Initial')
      let release!: () => void
      let began!: () => void
      let finished!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const started = new Promise<void>((resolve) => {
        began = resolve
      })
      const done = new Promise<void>((resolve) => {
        finished = resolve
      })
      const revisions: number[] = []
      setProp(input, 'onInput', async (event: InputEvent) => {
        revisions.push(event.revision)
        if (revisions.length === 1) {
          began()
          await gate
        }
        setProp(input, 'value', event)
        if (revisions.length === 2) finished()
      })
      const root = render(() => content(input, text), window)
      try {
        await root.ready
        setProp(text, 'text', 'input before acknowledgement')
        await root.flush()
        await started
        setProp(text, 'text', 'Between native edits')
        await root.flush()
        setProp(text, 'text', 'input before acknowledgement')
        await root.flush()
        const handle = observations.inputs[0]!
        expect(actual.input(handle).revision).toBe(2)
        const before = root.diagnostics
        release()
        await done
        await root.flush()
        expect(revisions).toEqual([1, 2])
        expect(actual.input(handle)).toEqual({ value: 'newer native edit', revision: 2 })
        expect(root.diagnostics.mutations.set).toBe(before.mutations.set)
        expect(root.diagnostics.commits).toBe(before.commits)
      } finally {
        release()
        await root.dispose()
      }
    }))

  test('rejects unversioned changes and malformed or invalid initial intents', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid input validation' })
      const input = inputNode()
      for (const value of [
        1,
        null,
        [],
        { value: 'x' },
        { value: 'x', revision: -1 },
        { value: 'x', revision: 0, extra: true },
      ])
        assert.throws(() => setProp(input, 'value', value))
      const root = render(() => input, window)
      await root.ready
      setProp(input, 'value', 'Unversioned replacement')
      await assert.rejects(root.flush(), /input-value-requires-revision/)
      expect(app.diagnostics.nodes).toBe(1)
      const uncreated = inputNode()
      setProp(uncreated, 'value', { value: 'initial', revision: 9 })
      const invalid = render(() => uncreated, window)
      await assert.rejects(invalid.ready, /revision zero/)
      expect(app.diagnostics.nodes).toBe(1)
    }))
  test('a native observation cannot authorize a different input node', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid foreign input event' })
      const source = inputNode()
      const target = inputNode()
      const marker = createElement('text')
      setProp(marker, 'text', 'Initial')
      let received!: () => void
      const eventReceived = new Promise<void>((resolve) => {
        received = resolve
      })
      setProp(source, 'onInput', (event: InputEvent) => {
        setProp(target, 'value', event)
        received()
      })
      const first = render(() => content(source, marker), window)
      await first.ready
      const second = render(() => target, window)
      await second.ready
      setProp(marker, 'text', 'input before acknowledgement')
      await first.flush()
      await eventReceived
      await assert.rejects(second.flush(), /belongs to another node/)
      expect(first.diagnostics.nodes).toBe(4)
      expect(second.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.callbacks).toBe(1)
      await first.dispose()
    }))
})
