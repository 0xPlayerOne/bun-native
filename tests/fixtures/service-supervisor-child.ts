// Fixed cross-platform PTY child. No shell, inherited environment or descendants.
// Use the already-qualified raw-mode terminal surface, not a platform-dependent
// cooked console read. Parse complete bounded commands across data callbacks.
if (process.env['BUNLY_SERVICE_FIXTURE'] !== 'fixed-owned-service') process.exit(91)
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(90)
const mode = process.argv[2]
process.stdin.setRawMode(true)
process.stdin.resume()
let pending = ''
let ending = false
process.stdin.on('data', (bytes: Buffer) => {
  if (ending) return
  pending += bytes.toString('utf8')
  if (pending.length > 1024) process.exit(65)
  const end = pending.indexOf('\n')
  if (end < 0) return
  if (pending.slice(0, end).replace(/\r$/, '') !== 'finish' || end !== pending.length - 1)
    process.exit(64)
  ending = true
  process.stdout.write(`service:${mode}:final\r\n`, () => process.exit(mode === 'fail' ? 7 : 0))
})
process.stdout.write(`service:${mode}:ready\r\n`)
