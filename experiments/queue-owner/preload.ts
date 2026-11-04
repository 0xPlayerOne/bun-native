/** Research-only idle-queue ownership contrast; never changes the test oracle. */
import { afterAll, spyOn } from 'bun:test'
import * as core from '../../packages/core/src/application.ts'
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const mode = process.env['BUN_NATIVE_QUEUE_OWNER_VARIANT']
const output = process.env['BUN_NATIVE_QUEUE_OWNER_REPORT']
if (
  !['dormant', 'release-tail', 'retain-tail'].includes(mode ?? '') ||
  !output ||
  !isAbsolute(output)
)
  throw new Error('The queue-owner observer requires an explicit variant and absolute output')
const applications = new Set<WeakRef<Awaited<ReturnType<typeof core.createApplication>>>>()
const held: Promise<void>[] = []
const checkpoints: { eligible: number; replaced: number; held: number }[] = []
const originalCreate = core.createApplication
spyOn(core, 'createApplication').mockImplementation(async (...args) => {
  const application = await originalCreate(...args)
  applications.add(new WeakRef(application))
  return application
})

function observeIdleQueues(): void {
  let eligible = 0
  let replaced = 0
  for (const reference of applications) {
    const application = reference.deref()
    if (!application) {
      applications.delete(reference)
      continue
    }
    if (
      Reflect.get(application, 'phase') !== 'running' ||
      application.diagnostics.queuedTransactions !== 0
    )
      continue
    if (!(Reflect.get(application, 'tail') instanceof Promise))
      throw new Error('The exact application source no longer exposes the expected promise')
    if (Bun.peek.status(Reflect.get(application, 'tail')) !== 'fulfilled') continue
    eligible++
    if (mode === 'retain-tail') held.push(Reflect.get(application, 'tail'))
    if (mode === 'release-tail' || mode === 'retain-tail') {
      if (!Reflect.set(application, 'tail', Promise.resolve()))
        throw new Error('Unable to replace the fulfilled idle tail in the research process')
      replaced++
    }
  }
  checkpoints.push({ eligible, replaced, held: held.length })
}

const originalGc = Bun.gc
Bun.gc = (...args: Parameters<typeof Bun.gc>): ReturnType<typeof Bun.gc> => {
  observeIdleQueues()
  return originalGc(...args)
}
afterAll(() => {
  writeFileSync(
    output,
    JSON.stringify(
      {
        scope: 'Research only; no added collection, sleep or assertion replacement',
        mode,
        bunRevision: Bun.revision,
        checkpoints,
        heldCount: held.length,
      },
      null,
      2
    ) + '\n',
    { flag: 'w' }
  )
})
