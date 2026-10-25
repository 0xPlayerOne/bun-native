/** Fixed PTY child for the runtime terminal service. Never launches a shell or descendant. */
import { Buffer } from 'node:buffer'

if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error('Terminal service fixture requires a real terminal')
process.stdin.setRawMode(true)
process.stdin.resume()

let sequence = 0
const marker = (value: Record<string, unknown>) =>
  `\r\nBUNLYPTY|${sequence++}|${Buffer.from(JSON.stringify(value)).toString('base64')}|END\r\n`
const send = (value: Record<string, unknown>) => process.stdout.write(marker(value))
let pending = ''

process.stdin.on('data', (bytes: Buffer) => {
  pending += bytes.toString('utf8')
  if (pending.length > 4096) process.exit(65)
  for (;;) {
    const end = pending.indexOf('\n')
    if (end < 0) break
    const command = pending.slice(0, end).replace(/\r$/, '')
    pending = pending.slice(end + 1)
    if (command.startsWith('input:')) {
      const encoded = command.slice('input:'.length)
      const value = Buffer.from(encoded, 'base64')
      if (value.toString('base64') !== encoded || value.byteLength > 1024) process.exit(64)
      send({ type: 'input', value: value.toString('utf8') })
    } else if (command === 'size') {
      const refresh: unknown = Reflect.get(process.stdout, '_refreshSize')
      if (typeof refresh !== 'function') throw new Error('Pinned console size refresh unavailable')
      refresh.call(process.stdout)
      send({ type: 'size', cols: process.stdout.columns, rows: process.stdout.rows })
    } else if (command === 'binary') {
      process.stdout.write(new Uint8Array([0xf0, 0x9f]))
      process.stdout.write(new Uint8Array([0x90, 0x99, 0xff]))
      send({ type: 'binary-complete' })
    } else if (command === 'exit') {
      process.stdout.write(marker({ type: 'final' }), () => process.exit(7))
    } else if (command !== 'wait') process.exit(64)
  }
})

send({
  type: 'ready',
  tty: true,
  token: process.env['BUNLY_TERMINAL_FIXTURE'],
  inheritedSentinel: process.env['BUNLY_PARENT_ONLY'] ?? null,
})
