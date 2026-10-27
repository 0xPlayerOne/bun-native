/** Fixed native-owned PTY child; emits continuously through backend replacements. */
export {}
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Expected a real PTY')
process.stdin.setRawMode(true)
process.stdin.resume()
let sequence = 0,
  pending = '',
  ended = false
function record(kind: 'ready' | 'tick' | 'ack' | 'final', revision = 0): void {
  if (sequence >= 20_000) process.exit(66)
  process.stdout.write(`BUNLYM6|${sequence++}|${kind}|${revision}|café-🐙\r\n`)
}
record('ready')
const ticker = setInterval(() => record('tick'), 20)
process.stdin.on('data', (bytes: Buffer) => {
  if (ended) return
  pending += bytes.toString('utf8')
  if (pending.length > 4096) process.exit(65)
  for (;;) {
    const newline = pending.indexOf('\n')
    if (newline < 0) break
    const line = pending.slice(0, newline).replace(/\r$/, '')
    pending = pending.slice(newline + 1)
    if (/^ack:(?:[0-9]|[1-9][0-9]{1,2})$/.test(line) && Number(line.slice(4)) <= 500)
      record('ack', Number(line.slice(4)))
    else if (line === 'exit') {
      ended = true
      clearInterval(ticker)
      record('final')
      process.stdout.write('', () => process.exit(0))
    } else process.exit(64)
  }
})
