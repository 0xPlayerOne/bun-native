import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { cefRpcSchema } from './rpc-contract.ts'
import { defineRpc, procedure, RpcError } from '../../packages/contracts/src/rpc.ts'

// Deliberately admit an invalid echo input on this side only. The actual Bun
// server must independently validate it after the complete native roundtrip.
const probeSchema = defineRpc({
  ...cefRpcSchema,
  echo: procedure((value: unknown) => value, cefRpcSchema.echo.output),
})
export const cefRpcClient = new RpcClient(probeSchema, await waitForCefRpcTransport(), {
  limits: { maxFrameBytes: 24 * 1024, maxMetadataBytes: 16 * 1024 },
})
const client = cefRpcClient
const echoed = await client.call('echo', 'renderer')
if (echoed !== 'bun:renderer') throw new Error('Native JSON RPC roundtrip failed')
await client.call('echo', 123).then(
  () => {
    throw new Error('Bun accepted an invalid renderer input')
  },
  (error: unknown) => {
    if (!(error instanceof RpcError) || error.code !== 'BAD_REQUEST') throw error
  }
)
const source = new Uint8Array([0, 1, 2, 127, 128, 255])
const returned = await client.call('binary', source)
if (returned.length !== source.length || returned.some((byte, index) => byte !== source[index]))
  throw new Error('Native binary RPC roundtrip failed')
const controller = new AbortController()
const cancelled = client.call('wait', 'cancel', { signal: controller.signal })
void cancelled.catch(() => {})
if ((await client.call('waitStarted', 'cancel')) !== 'started')
  throw new Error('Backend handler did not start before cancellation')
controller.abort()
await cancelled.then(
  () => {
    throw new Error('Native RPC cancellation unexpectedly resolved')
  },
  () => {}
)
if ((await client.call('waitAborted', 'cancel')) !== 'aborted')
  throw new Error('Backend handler did not observe cancellation')
console.log(
  'BUNLY_RPC_EVIDENCE:' +
    JSON.stringify({
      schema: 2,
      json: echoed,
      binary: [...returned],
      cancellation: 'backend-started-and-aborted',
      validation: 'backend-rejected-invalid-input',
    })
)
