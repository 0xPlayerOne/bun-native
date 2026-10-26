// Fixed cross-platform PTY child. No shell, inherited environment or descendant process.
import { writeSync } from 'node:fs'
const mode = process.argv[2]
if (process.env['BUNLY_SERVICE_FIXTURE'] !== 'fixed-owned-service') process.exit(91)
writeSync(1, `service:${mode}:ready\n`)
// Readiness is an output receipt; one explicit fixture input triggers the outcome.
for await (const bytes of Bun.stdin.stream()) {
  if (new TextDecoder().decode(bytes).includes('finish')) {
    writeSync(1, `service:${mode}:final\n`)
    process.exit(mode === 'fail' ? 7 : 0)
  }
}
process.exit(92)
