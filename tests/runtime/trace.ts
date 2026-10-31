// Temporary diagnostic-branch instrumentation; not part of the application API.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function trace(role: string, event: string, detail: unknown): void {
  const directory = process.env['BUN_NATIVE_DIAGNOSTIC_DIR']
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  appendFileSync(
    join(directory, `${role}-${process.pid}.jsonl`),
    JSON.stringify({
      time: Date.now(),
      elapsed: performance.now(),
      pid: process.pid,
      event,
      detail,
    }) + '\n'
  )
}
