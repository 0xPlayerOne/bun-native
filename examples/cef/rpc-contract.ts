import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'

const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Expected string')
  return value
}
const binary = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected bytes')
  return value
}

export const cefRpcSchema = defineRpc({
  echo: procedure(text, text),
  binary: procedure(binary, binary),
  wait: procedure(text, text),
  waitStarted: procedure(text, text),
  waitAborted: procedure(text, text),
})
