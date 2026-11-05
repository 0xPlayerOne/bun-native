import { resolve } from 'node:path'
import type { CollectabilityScenario, CollectionObservation } from './collectability-scenarios.ts'

const script = resolve(import.meta.dir, 'collectability-scenarios.ts')

/**
 * Observe a scenario in a child Bun process with DFG compilation disabled, so
 * a compiled-code root cannot be mistaken for an application ownership edge.
 */
export async function observeScenario(
  scenario: CollectabilityScenario
): Promise<CollectionObservation> {
  const child = Bun.spawn([process.execPath, '--conditions=browser', script, scenario], {
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env, BUN_JSC_useDFGJIT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0)
    throw new Error(
      `Collectability scenario ${scenario} exited ${exitCode}: ${stderr.slice(-2000)}`
    )
  const line = stdout.trim().split('\n').at(-1) ?? ''
  const result = JSON.parse(line) as { scenario: string; observation: CollectionObservation }
  if (result.scenario !== scenario) throw new Error(`Unexpected scenario report: ${line}`)
  return result.observation
}
