/** Research-only collector contrast; preserves producer source and checkpoint count. */
import { gcAndSweep, releaseWeakRefs } from 'bun:jsc'
const original = Bun.gc
const method = process.env['BUN_NATIVE_COLLECTOR_CONTROL']
if (!['bun', 'release-sweep', 'sweep'].includes(method ?? ''))
  throw new Error('An explicit collector control is required')
Reflect.set(Bun, 'gc', (force?: boolean) => {
  const stack = new Error('collector observation location').stack ?? ''
  if (!/tests[/\\]solid[/\\]renderer\.test\.ts/.test(stack)) return original(force)
  console.error(`Bun Native research checkpoint: ${method}`)
  if (method === 'bun') return original(force)
  if (method === 'release-sweep') releaseWeakRefs()
  return gcAndSweep()
})
