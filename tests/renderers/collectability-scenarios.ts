/**
 * Collectability scenarios, run as a child of `collectability.ts` with JSC DFG
 * compilation disabled. Prints one JSON observation line on stdout.
 *
 * The pinned Bun's DFG tier can keep a cell reachable from compiled code after
 * every application edge is gone; with DFG disabled the same scenarios clear
 * deterministically (benchmarks/retention/settled-collection.md). Ownership
 * edges are unaffected by the compiler tier, so the negative control below
 * still detects a callback that is never released.
 */
import { render, createElement, setProp, type RenderRoot } from '@bun-native/solid'
import { watchWindow } from '../../packages/renderer/src/window-lifetime.ts'
import { rethrowWithRetentionDiagnostic } from '../solid/retention-diagnostic.ts'
import { withApp } from './support.ts'

type Window = Parameters<typeof watchWindow>[0]
export type CollectionObservation = { readonly survivors: readonly number[] }

/** The original two fixed checkpoints from the in-process tests; nothing added. */
async function observeCollection(
  references: readonly Pick<WeakRef<object>, 'deref'>[]
): Promise<CollectionObservation> {
  await Bun.sleep(0)
  Bun.gc(true)
  await Bun.sleep(0)
  Bun.gc(true)
  return {
    survivors: references.flatMap((reference, index) =>
      reference.deref() === undefined ? [] : [index]
    ),
  }
}

function watched(window: Window, onClose: () => void) {
  const callback = () => onClose()
  return { release: watchWindow(window, callback), reference: new WeakRef(callback) }
}

function label(text: string) {
  const node = createElement('text')
  setProp(node, 'text', text)
  return node
}

const scenarios = {
  /** Retained unsubscribe handles must not retain their released callbacks. */
  async 'revoked-callbacks'() {
    let observation
    await withApp(async (app) => {
      const window = await app.openWindow({ title: 'Revoked callback ownership' })
      const observations = Array.from({ length: 10 }, () =>
        watched(window, () => {
          throw new Error('Released listener must never execute')
        })
      )
      for (const item of observations) item.release()
      observation = await observeCollection(observations.map(({ reference }) => reference))
      // Deliberately retain and exercise every release function after collection.
      for (const item of observations) item.release()
      await window.close()
    })
    return observation
  },
  /** Window completion releases callbacks even while unsubscribe handles stay live. */
  async 'completed-callbacks'() {
    let observation
    await withApp(async (app) => {
      const window = await app.openWindow({ title: 'Completed callback ownership' })
      let called = 0
      const observations = Array.from({ length: 10 }, () => watched(window, () => called++))
      await window.close()
      if (called !== 10) throw new Error(`Expected 10 completion callbacks, observed ${called}`)
      observation = await observeCollection(observations.map(({ reference }) => reference))
      for (const item of observations) item.release()
      if (called !== 10) throw new Error('A released completion callback ran again')
    })
    return observation
  },
  /** Negative control: an unreleased subscription keeps its callback reachable. */
  async 'unreleased-callback-control'() {
    let observation
    await withApp(async (app) => {
      const window = await app.openWindow({ title: 'Retained callback control' })
      const observations = Array.from({ length: 10 }, () => watched(window, () => {}))
      for (const [index, item] of observations.entries()) if (index !== 6) item.release()
      observation = await observeCollection(observations.map(({ reference }) => reference))
      observations[6]!.release()
      await window.close()
    })
    return observation
  },
  /** Disposed Solid roots are collectable while their native window stays open. */
  async 'solid-roots'() {
    let observation
    await withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid root retention' })
      async function cycle(index: number) {
        const root = render(() => label(String(index)), window)
        await root.ready
        await root.dispose()
        return new WeakRef(root)
      }
      const references: WeakRef<RenderRoot>[] = []
      for (let index = 0; index < 10; index++) references.push(await cycle(index))
      observation = await observeCollection(references)
      if (observation.survivors.length) {
        try {
          rethrowWithRetentionDiagnostic(
            new Error('Disposed Solid roots remain observable'),
            references,
            { application: app, window }
          )
        } catch {
          // Reported to the parent through the observation itself.
        }
      }
      if (app.diagnostics.windows !== 1 || app.diagnostics.nodes !== 1)
        throw new Error('Expected only the open window and its root node')
    })
    return observation
  },
}

export type CollectabilityScenario = keyof typeof scenarios

const name = process.argv[2] as CollectabilityScenario
if (!Object.hasOwn(scenarios, name)) throw new Error(`Unknown collectability scenario ${name}`)
const observation = await scenarios[name]()
console.log(JSON.stringify({ scenario: name, observation }))
