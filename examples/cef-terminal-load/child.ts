/** A fixed, direct real Bun PTY. Same 32 Unicode records as the functional fixture. */
import { Buffer } from 'node:buffer'
import { BATCHES, LOAD, loadRecord } from './workload.ts'
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Real PTY required')
process.stdin.setRawMode(true)
process.stdin.resume()
let pending = ''
let batch = 0
function marker(sequence: number, value: object) {
  return `\r\nBUNLYTERM|${sequence}|${Buffer.from(JSON.stringify(value)).toString('base64')}|END\r\n`
}
process.stdin.on('data', (bytes: Buffer) => {
  pending += bytes.toString('utf8')
  if (pending.length > 64) process.exit(65)
  for (;;) {
    const end = pending.indexOf('\n')
    if (end < 0) break
    const command = pending.slice(0, end)
    pending = pending.slice(end + 1)
    if (command === `batch:${batch}` && batch < BATCHES) {
      process.stdout.write('\r\ncafé-🐙\r\n')
      for (let index = 0; index < LOAD.recordsPerBatch; index++)
        process.stdout.write(
          marker(batch * (LOAD.recordsPerBatch + 1) + index, loadRecord(batch, index))
        )
      process.stdout.write(
        marker(batch * (LOAD.recordsPerBatch + 1) + LOAD.recordsPerBatch, {
          type: 'batch-complete',
          batch,
          tty: true,
        }).slice(0, -2)
      )
      batch++
    } else if (command === 'exit' && batch === BATCHES) {
      process.stdout.write(
        marker(BATCHES * (LOAD.recordsPerBatch + 1), { type: 'final', batches: batch }).slice(
          0,
          -2
        ),
        () => process.exit(0)
      )
    } else process.exit(64)
  }
})
