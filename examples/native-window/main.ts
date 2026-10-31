import { NativeHost, type WindowEvent } from '@bun-native/runtime'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the prebuilt native host executable')
const host = await NativeHost.launch({ executable: resolve(executable) })
const evidencePath = process.env['BUN_NATIVE_EVIDENCE_LOG']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']

function record(event: WindowEvent): void {
  if (evidencePath && nonce)
    appendFileSync(
      evidencePath,
      `${JSON.stringify({ nonce, ...event, stage: 'bun-application' })}\n`
    )
}

let clicks = 0
try {
  await host.send({ type: 'open', title: 'Bun Native BN0', text: 'Clicks: 0', input: '' })
  for await (const event of host) {
    record(event)
    if (event.type === 'closed') break
    if (event.type === 'click') {
      clicks += 1
      await host.send({ type: 'update', text: `Clicks: ${clicks}` })
    }
  }
} finally {
  await host.shutdown()
}
