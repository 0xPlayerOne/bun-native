/** Fixed Bun PTY child. It never starts a shell or descendant and never prints paths, env, or PIDs. */
import { Buffer } from 'node:buffer'

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('A real terminal is required')
process.stdin.setRawMode(true)
process.stdin.resume()

let sequence = 0
let pending = ''
const marker = (value: Record<string, unknown>) =>
  `\r\nBUNLYTERM|${sequence++}|${Buffer.from(JSON.stringify(value)).toString('base64')}|END\r\n`
const send = (value: Record<string, unknown>) => process.stdout.write(marker(value))

process.stdin.on('data', (bytes: Buffer) => {
  pending += bytes.toString('utf8')
  if (pending.length > 8192) process.exit(65)
  for (;;) {
    const end = pending.indexOf('\n')
    if (end < 0) break
    const command = pending.slice(0, end).replace(/\r$/, '')
    pending = pending.slice(end + 1)
    if (command.startsWith('input:')) {
      const encoded = command.slice(6)
      const value = Buffer.from(encoded, 'base64')
      if (value.toString('base64') !== encoded || value.byteLength > 1024) process.exit(64)
      send({ type: 'input', value: value.toString('utf8') })
    } else if (command === 'resize') {
      const refresh: unknown = Reflect.get(process.stdout, '_refreshSize')
      if (typeof refresh !== 'function') throw new Error('Pinned console size refresh unavailable')
      refresh.call(process.stdout)
      send({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows })
    } else if (command === 'binary') {
      process.stdout.write(new Uint8Array([0xf0, 0x9f]))
      process.stdout.write(new Uint8Array([0x90, 0x99, 0xff]))
      send({ type: 'binary-complete' })
    } else if (command.startsWith('emit:')) {
      const count = Number(command.slice(5))
      if (!Number.isSafeInteger(count) || count < 1 || count > 2048) process.exit(64)
      for (let index = 0; index < count; index++)
        send({ type: 'record', index, text: `fixed-${index}-café-🐙` })
      send({ type: 'emit-complete', count })
    } else if (command === 'stall') {
      send({ type: 'stall', payload: 's'.repeat(4096) })
    } else if (command === 'overload') {
      for (let index = 0; index < 2048; index++)
        send({ type: 'overload', index, payload: 'o'.repeat(192) })
    } else if (command === 'exit') {
      process.stdout.write(marker({ type: 'final' }), () => process.exit(0))
    } else if (command !== 'wait') process.exit(64)
  }
})

process.stdout.write('café-🐙\r\n')
send({ type: 'ready', tty: true, token: process.env['BUNLY_TERMINAL_FIXTURE'] ?? null })
