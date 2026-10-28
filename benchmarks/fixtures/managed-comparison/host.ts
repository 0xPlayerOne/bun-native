/** Private loopback fixture protocol; never a native application API. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export function comparisonConfiguration() {
  const origin = process.env['BUNLY_COMPARISON_ORIGIN'] ?? ''
  const hostToken = process.env['BUNLY_COMPARISON_HOST_TOKEN'] ?? ''
  const rendererToken = process.env['BUNLY_COMPARISON_RENDERER_TOKEN'] ?? ''
  const url = new URL(origin)
  assert.ok(
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.origin === origin
  )
  assert.ok([hostToken, rendererToken].every((value) => /^[a-f0-9]{48}$/.test(value)))
  return { origin, hostToken, rendererToken, instance: randomUUID() }
}
export async function comparisonRegister(
  config: ReturnType<typeof comparisonConfiguration>,
  value: {
    revision: number
    framework: string
    version: string
    identities: { window: string; view: string; session: string } | null
  }
) {
  const response = await fetch(config.origin + '/host', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', 'x-bunly-probe-token': config.hostToken },
    body: JSON.stringify({
      ...value,
      instance: config.instance,
      pid: process.pid,
      runtimeVersion: Bun.version,
    }),
  })
  assert.equal(response.status, 200, 'Comparison backend registration rejected')
}
export async function comparisonCommands(
  config: ReturnType<typeof comparisonConfiguration>,
  edit?: (revision: number) => Promise<void>
): Promise<void> {
  const deadline = performance.now() + 120_000
  while (performance.now() < deadline) {
    const response = await fetch(config.origin + '/command', {
      headers: { 'x-bunly-probe-token': config.hostToken },
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200, 'Comparison command channel failed')
    const command = (await response.json()) as { action: string; revision?: number }
    if (command.action === 'quit') return
    if (command.action === 'edit') {
      assert.ok(edit && Number.isSafeInteger(command.revision) && Number(command.revision) > 0)
      await edit(command.revision!)
    } else {
      assert.equal(command.action, 'wait')
      await Bun.sleep(20)
    }
  }
  throw new Error('Comparison application deadline')
}
