/** Fixed, bounded PTY child. Never starts shells, descendants or production commands. */
import { Buffer } from 'node:buffer'
if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error('PTY fixture requires a real terminal')
process.stdin.setRawMode(true)
process.stdin.resume()
let sequence = 0
const marker = (value: Record<string, unknown>) =>
  `\r\nBUNLYPTY|${sequence++}|${Buffer.from(JSON.stringify(value)).toString('base64')}|END\r\n`
const send = (value: Record<string, unknown>) => process.stdout.write(marker(value))
let pending = ''
process.stdin.on('data', (bytes: Buffer) => {
  pending += bytes.toString('utf8')
  if (pending.length > 1024) process.exit(65)
  for (;;) {
    const end = pending.indexOf('\n')
    if (end < 0) break
    const command = pending.slice(0, end).replace(/\r$/, '')
    pending = pending.slice(end + 1)
    if (command === 'input') send({ type: 'input', value: 'owned-input' })
    else if (command === 'size') {
      // The pinned Bun compatibility surface refreshes the underlying console
      // dimensions. Windows ConPTY does not send SIGWINCH to update cached fields.
      const refresh: unknown = Reflect.get(process.stdout, '_refreshSize')
      if (typeof refresh !== 'function') throw new Error('Pinned console size refresh unavailable')
      refresh.call(process.stdout)
      send({ type: 'size', cols: process.stdout.columns, rows: process.stdout.rows })
    } else if (command === 'bulk') {
      for (let i = 0; i < 64; i++)
        send({ type: 'chunk', index: i, value: 'caf\u00e9-\ud83d\udc19' })
      process.stdout.write('\r\nUNICODE caf\u00e9-\ud83d\udc19\r\n')
      send({ type: 'bulk-complete', count: 64 })
    } else if (command === 'burst') {
      // Finite overload control. Remain alive afterwards so natural exit cannot
      // masquerade as the owned producer being stopped by the source adapter.
      for (let i = 0; i < 8192; i++) process.stdout.write('x'.repeat(256) + '\n')
    } else if (command === 'exit') {
      process.stdout.write(marker({ type: 'final', value: 'last-output-before-exit' }), () =>
        process.exit(0)
      )
    } else process.exit(64)
  }
})
send({ type: 'ready', tty: true, cols: process.stdout.columns, rows: process.stdout.rows })
