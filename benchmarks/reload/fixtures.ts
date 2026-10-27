/** Fixed synthetic inputs, written only inside the qualifier's fresh private directory. */
export const moduleSource = String.raw`
import { revision } from './dependency.ts'
const globals = globalThis as typeof globalThis & { __bunlyReloadProbe?: number }
globals.__bunlyReloadProbe = (globals.__bunlyReloadProbe ?? 0) + 1
const globalInstance = globals.__bunlyReloadProbe
let count = 0
let ticks = 0
let timer: ReturnType<typeof setInterval> | undefined
let server: ReturnType<typeof Bun.serve> | undefined
export function inspect() { return { revision, moduleInstance: ++count, globalInstance } }
export function open() {
  timer = setInterval(() => { ticks++ }, 2)
  server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => Response.json({ revision, ticks }) })
  return server.port
}
export function readTicks() { return ticks }
export function stop() { if (timer) clearInterval(timer); server?.stop(true) }
`
export const rejectedSources = {
  syntax: 'export const invalid = ;',
  missing: "import './deliberately-absent-dependency.ts'",
  initialization: "throw new Error('INTENTIONAL_INITIALIZATION_FAILURE')",
  pending: 'await new Promise(() => {}); export const never = true',
} as const
export type ReloadCandidate = 'import' | 'graph' | 'worker' | 'process'
export const reloadCandidates: readonly ReloadCandidate[] = ['import', 'graph', 'worker', 'process']
export interface ProbeModule {
  inspect(): { revision: number; moduleInstance: number; globalInstance: number }
  open(): number
  readTicks(): number
  stop(): void
}

/** RSS is process-wide; Worker heap counters belong only to the main isolate. */
export function reloadMemoryScope(mode: ReloadCandidate): string {
  if (mode === 'process') return 'stable-parent-rss-and-heap-excludes-generation-child'
  if (mode === 'worker') return 'process-rss-includes-workers-main-isolate-heap-only'
  return 'same-process-main-isolate-rss-and-heap'
}
