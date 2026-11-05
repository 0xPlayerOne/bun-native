/**
 * Fixed-checkpoint versus settled collectability control over real Solid roots
 * and headless public-core IPC (no native rendering).
 *
 *   bun --conditions=browser benchmarks/retention/solid-collection-control.ts <fixed|settled> [trials]
 *
 * Set BUN_JSC_useDFGJIT=0 to remove the DFG tier. Results are recorded in
 * settled-collection.md.
 */
import { createElement, render, setProp, type RenderRoot } from '@bun-native/solid'
import { observeCollection } from '../solid/collection.ts'
import { withApp } from '../../tests/renderers/support.ts'

const mode = process.argv[2]
if (mode !== 'fixed' && mode !== 'settled') throw new Error('Mode must be fixed or settled')
const trials = Number(process.argv[3] ?? 300)

function label(text: string) {
  const node = createElement('text')
  setProp(node, 'text', text)
  return node
}

let failures = 0
const survivorIndexes: Record<number, number> = {}
const rounds: Record<number, number> = {}
await withApp(async (app) => {
  const window = await app.openWindow({ title: 'Collection control' })
  async function cycle(index: number) {
    const root = render(() => label(String(index)), window)
    await root.ready
    await root.dispose()
    return new WeakRef(root)
  }
  for (let trial = 0; trial < trials; trial++) {
    const references: WeakRef<RenderRoot>[] = []
    for (let index = 0; index < 10; index++) references.push(await cycle(index))
    let survivors: readonly number[]
    if (mode === 'fixed') {
      // The previous oracle: two sleep(0)/gc(true) checkpoints.
      await Bun.sleep(0)
      Bun.gc(true)
      await Bun.sleep(0)
      Bun.gc(true)
      survivors = references.flatMap((reference, index) => (reference.deref() ? [index] : []))
    } else {
      const observation = await observeCollection(references)
      survivors = observation.survivors
      rounds[observation.rounds] = (rounds[observation.rounds] ?? 0) + 1
    }
    if (survivors.length) failures++
    for (const index of survivors) survivorIndexes[index] = (survivorIndexes[index] ?? 0) + 1
    await Bun.sleep(0)
  }
  await window.close()
})
console.log(
  JSON.stringify({
    mode,
    dfg: process.env['BUN_JSC_useDFGJIT'] === '0' ? 'disabled' : 'enabled',
    bunRevision: Bun.revision,
    trials,
    failedTrials: failures,
    survivorIndexes,
    rounds,
  })
)
