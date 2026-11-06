/** @jsxImportSource @bun-native/react */
import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { render, type NativeRef } from '@bun-native/react'
import {
  Component,
  createElement,
  createRef,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { withApp } from '../renderers/support.ts'

describe('React reconciler over shared native core (headless subprocess)', () => {
  test('mount, state batching, text updates, refs and effect disposal', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'React state' })
      const reference = createRef<NativeRef>()
      let update!: Dispatch<SetStateAction<number>>
      const effects: number[] = []
      const cleanups: number[] = []
      function Counter() {
        const [count, setCount] = useState(0)
        update = setCount
        useEffect(() => {
          effects.push(count)
          return () => {
            cleanups.push(count)
          }
        }, [count])
        return (
          <box>
            <text ref={reference}>Count: {count}</text>
          </box>
        )
      }
      const root = render(<Counter />, window)
      await root.ready
      await root.flush()
      expect(effects).toEqual([0])
      expect(reference.current).not.toBeNull()
      expect(application.diagnostics.nodes).toBe(4)
      const identity = reference.current
      const before = root.diagnostics
      update(1)
      update(2)
      update(3)
      await root.flush()
      expect(effects).toEqual([0, 3])
      expect(reference.current).toBe(identity)
      expect(root.diagnostics.mutations.set - before.mutations.set).toBe(1)
      expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
      await root.dispose()
      await root.dispose()
      expect(reference.current).toBeNull()
      expect(cleanups).toEqual([0, 3])
      expect(root.diagnostics.nodes).toBe(0)
      expect(application.diagnostics.nodes).toBe(1)
    }))

  test('keyed reorder retains refs and emits one native move; deletion cleans one owner', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'React keys' })
      const refs = new Map<string, ReturnType<typeof createRef<NativeRef>>>()
      const removed: string[] = []
      function Row({ name }: { name: string }) {
        useEffect(
          () => () => {
            removed.push(name)
          },
          [name]
        )
        return <text ref={refs.get(name)!}>{name}</text>
      }
      const ids = ['a', 'b', 'c']
      for (const id of ids) refs.set(id, createRef())
      const rows = (order: string[]) => (
        <box>
          {order.map((name) => (
            <Row key={name} name={name} />
          ))}
        </box>
      )
      const root = render(rows(ids), window)
      await root.ready
      const identities = ids.map((id) => refs.get(id)!.current)
      const before = root.diagnostics
      await root.render(rows(['c', 'a', 'b']))
      expect(ids.map((id) => refs.get(id)!.current)).toEqual(identities)
      expect(root.diagnostics.mutations.insert - before.mutations.insert).toBe(1)
      expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
      expect(root.diagnostics.mutations.remove).toBe(before.mutations.remove)
      expect(removed).toEqual([])
      await root.render(rows(['c', 'a']))
      expect(removed).toEqual(['b'])
      expect(refs.get('b')!.current).toBeNull()
      expect(root.diagnostics.mutations.remove - before.mutations.remove).toBe(1)
      await root.dispose()
      expect(removed.sort()).toEqual(ids)
    }))

  test('render errors reach a React error boundary before native mutation', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'React boundary' })
      const caught: unknown[] = []
      class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
        override state = { failed: false }
        static getDerivedStateFromError() {
          return { failed: true }
        }
        override componentDidCatch(error: unknown) {
          caught.push(error)
        }
        override render() {
          return this.state.failed ? <text>Recovered</text> : this.props.children
        }
      }
      const root = render(<Boundary>{createElement('div')}</Boundary>, window)
      await root.ready
      expect(caught).toHaveLength(1)
      expect(String(caught[0])).toContain('native-element:div')
      expect(root.diagnostics.nodes).toBe(2)
      await root.render(<text>Usable after the handled error</text>)
      expect(root.diagnostics.nodes).toBe(2)
      await root.dispose()
    }))

  test('unsupported tags and unknown undefined properties reject readiness and clean up', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'React unsupported' })
      for (const element of [
        createElement('webview'),
        createElement('box', { dangerouslySetInnerHTML: undefined }),
      ]) {
        const root = render(element, window)
        await assert.rejects(root.ready, /Unsupported native feature/)
        await assert.rejects(root.closed, /Unsupported native feature/)
        expect(root.diagnostics.nodes).toBe(0)
        expect(application.diagnostics.nodes).toBe(1)
      }
    }))

  test('asynchronous native rejection revokes refs and framework effects', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'React rejection' })
      const reference = createRef<NativeRef>()
      let disposed = 0
      function Label({ value }: { value: string }) {
        useEffect(
          () => () => {
            disposed++
          },
          []
        )
        return <text ref={reference}>{value}</text>
      }
      const root = render(<Label value="Initial" />, window)
      await root.ready
      await assert.rejects(
        root.render(<Label value="reject transaction" />),
        /Requested test rejection/
      )
      await assert.rejects(root.closed, /Requested test rejection/)
      expect(reference.current).toBeNull()
      expect(disposed).toBe(1)
      expect(application.diagnostics.nodes).toBe(1)
      expect(application.diagnostics.callbacks).toBe(0)
    }))

  test('window close disposes the React owner and prevents later commits', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'React OS lifetime' })
      const reference = createRef<NativeRef>()
      let disposed = 0
      function Button() {
        useEffect(
          () => () => {
            disposed++
          },
          []
        )
        return (
          <button ref={reference} onClick={() => {}}>
            Button
          </button>
        )
      }
      const root = render(<Button />, window)
      await root.ready
      expect(application.diagnostics.callbacks).toBe(1)
      await window.close()
      await root.closed
      expect(reference.current).toBeNull()
      expect(disposed).toBe(1)
      expect(root.diagnostics.nodes).toBe(0)
      expect(application.diagnostics.callbacks).toBe(0)
      await assert.rejects(root.render(<text>Too late</text>), /React root is closed/)
    }))

  test('a keyed pane remount above the native batch limit commits as one React update', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'React large remount' })
      // Each row is three nodes, created and inserted: 60 rows exceed 256 operations.
      function Pane({ name, count }: { name: string; count: number }) {
        return (
          <box>
            {Array.from({ length: count }, (_, index) => (
              <box key={index}>
                <text>{`${name} ${index}`}</text>
                <text>detail</text>
              </box>
            ))}
          </box>
        )
      }
      const first = createRef<NativeRef>()
      let select!: Dispatch<SetStateAction<'a' | 'b'>>
      function App() {
        const [selected, setSelected] = useState<'a' | 'b'>('a')
        select = setSelected
        return (
          <box>
            <text ref={first}>{selected}</text>
            {selected === 'a' ? (
              <Pane key="a" name="A" count={60} />
            ) : (
              <Pane key="b" name="B" count={70} />
            )}
          </box>
        )
      }
      const root = render(<App />, window)
      await root.ready
      await root.flush()
      // The initial mount is itself one commit above the batch limit.
      const mounted = root.diagnostics.nodes
      expect(mounted).toBeGreaterThan(60 * 3)
      const identity = first.current
      const before = root.diagnostics
      select('b')
      await root.flush()
      expect(root.diagnostics.commits - before.commits).toBe(1)
      expect(root.diagnostics.mutations.create - before.mutations.create).toBe(1 + 70 * 3)
      expect(root.diagnostics.nodes).toBe(mounted + 10 * 3)
      expect(application.diagnostics.nodes).toBe(1 + mounted + 10 * 3)
      expect(first.current).toBe(identity)
      select('a')
      await root.flush()
      expect(root.diagnostics.nodes).toBe(mounted)
      await root.dispose()
      expect(application.diagnostics.nodes).toBe(1)
    }))
})
