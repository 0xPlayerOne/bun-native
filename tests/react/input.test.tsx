/** @jsxImportSource @bun-native/react */
import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { NativeStateError, type InputEvent, type InputState } from '@bun-native/core'
import { inputState, render, type NativeRef } from '@bun-native/react'
import { createElement, createRef, useState } from 'react'
import { observeWindow, withApp } from '../renderers/support.ts'

describe('React native input intents (headless subprocess)', () => {
  test('captures replacement revision/value before awaiting and preserves edits on appearance changes', () =>
    withApp(async (app) => {
      const actual = await app.openWindow({ title: 'React input replacement' })
      const { window, observations } = observeWindow(actual)
      const reference = createRef<NativeRef>()
      const onInput = () => {}
      const element = (props: { value?: string | InputState; placeholder?: string }) => (
        <input {...props} ref={reference} onInput={onInput} />
      )
      const root = render(element({ value: '' }), window)
      expect(() => inputState(reference.current!)).toThrow('no committed native handle')
      await root.ready
      const mounted = reference.current!
      const intent = { value: 'Submitted value', revision: inputState(mounted).revision }
      const applied = root.render(element({ value: intent }))
      intent.value = 'Mutation after submission'
      intent.revision = 999
      await applied
      const handle = observations.inputs[0]!
      expect(actual.input(handle)).toEqual({ value: 'Submitted value', revision: 1 })
      expect(inputState(mounted)).toEqual({ value: 'Submitted value', revision: 1 })
      await root.render(element({ value: intent, placeholder: 'New appearance' }))
      expect(actual.input(handle)).toEqual({ value: 'Submitted value', revision: 2 })
      const before = root.diagnostics
      await root.render(element({ placeholder: 'New appearance' }))
      expect(actual.input(handle)).toEqual({ value: 'Submitted value', revision: 2 })
      expect(root.diagnostics.mutations).toEqual(before.mutations)
      await root.dispose()
      expect(() => inputState(mounted)).toThrow('mounted native input')
      expect(() => inputState({} as NativeRef)).toThrow('staged native node')
    }))

  test('a delayed explicit replacement cannot acquire a newer native revision', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React stale input' })
      const marker = await window.batch((batch) => {
        const node = batch.create({ kind: 'text', text: 'Marker' })
        batch.append(window.root, node)
        return node
      })
      const root = render(<input value="" onInput={() => {}} />, window)
      await root.ready
      const edit = window.batch((batch) =>
        batch.set(marker, { kind: 'text', text: 'input before acknowledgement' })
      )
      const replacement = root.render(
        <input value={{ value: 'Obsolete text', revision: 0 }} onInput={() => {}} />
      )
      void replacement.catch(() => {})
      await edit
      await assert.rejects(replacement, NativeStateError)
      await assert.rejects(root.closed, /current observed revision/)
      expect(app.diagnostics.nodes).toBe(2)
      expect(app.diagnostics.callbacks).toBe(0)
    }))

  test('old actual event observations never echo over a newer ingested native edit', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React input event race' })
      const marker = await window.batch((batch) => {
        const node = batch.create({ kind: 'text', text: 'Marker' })
        batch.append(window.root, node)
        return node
      })
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
      const reference = createRef<NativeRef>()
      function Input() {
        const [value, setValue] = useState<string | InputState>('')
        return (
          <input
            ref={reference}
            value={value}
            onInput={async (event) => {
              revisions.push(event.revision)
              if (revisions.length === 1) {
                began()
                await gate
              }
              setValue(event)
              if (revisions.length === 2) finished()
            }}
          />
        )
      }
      const root = render(<Input />, window)
      try {
        await root.ready
        const edit = () =>
          window.batch((batch) =>
            batch.set(marker, { kind: 'text', text: 'input before acknowledgement' })
          )
        await edit()
        await started
        await edit()
        expect(inputState(reference.current!).revision).toBe(2)
        const before = root.diagnostics
        release()
        await done
        await root.flush()
        expect(revisions).toEqual([1, 2])
        expect(inputState(reference.current!)).toEqual({ value: 'newer native edit', revision: 2 })
        expect(root.diagnostics.mutations.set).toBe(before.mutations.set)
        expect(root.diagnostics.commits).toBe(before.commits)
      } finally {
        release()
        await root.dispose()
      }
    }))

  test('malformed intents and unversioned replacements fail without retaining native resources', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React input validation' })
      for (const value of [
        1,
        null,
        [],
        { value: 'x' },
        { value: 'x', revision: -1 },
        { value: 'x', revision: 0, extra: true },
        { value: 'x', revision: 9 },
      ]) {
        const root = render(createElement('input', { value }), window)
        await assert.rejects(root.ready, Error)
        await assert.rejects(root.closed, Error)
        expect(app.diagnostics.nodes).toBe(1)
      }
      const root = render(<input value="Initial" />, window)
      await root.ready
      await assert.rejects(
        root.render(<input value="Unversioned replacement" />),
        /input-value-requires-revision/
      )
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('an observed event cannot authorize another mounted input', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React foreign input observation' })
      const marker = await window.batch((batch) => {
        const node = batch.create({ kind: 'text', text: 'Marker' })
        batch.append(window.root, node)
        return node
      })
      let submit!: (event: InputEvent) => void
      function Target() {
        const [value, setValue] = useState<string | InputState>('')
        submit = setValue
        return <input value={value} />
      }
      const first = render(<input value="" onInput={(event) => submit(event)} />, window)
      await first.ready
      const second = render(<Target />, window)
      await second.ready
      await window.batch((batch) =>
        batch.set(marker, { kind: 'text', text: 'input before acknowledgement' })
      )
      await assert.rejects(second.closed, /belongs to another node/)
      expect(second.diagnostics.nodes).toBe(0)
      expect(first.diagnostics.nodes).toBe(2)
      expect(app.diagnostics.callbacks).toBe(1)
      await first.dispose()
    }))
})
