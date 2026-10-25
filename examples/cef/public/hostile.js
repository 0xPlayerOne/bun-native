globalThis.bridgePresent = typeof globalThis.__bunlyRpc !== 'undefined'
globalThis.streamBridgePresent = typeof globalThis.__bunlyStreams !== 'undefined'
globalThis.borrowedError = null
try {
  parent.__bunlyRpc.send(new ArrayBuffer(1), () => {})
  // Returning normally is a JS observation, not proof that native accepted it.
  globalThis.borrowedBridge = 'returned-without-exception'
} catch (error) {
  globalThis.borrowedError = String(error).slice(0, 256)
  // A size/queue/missing-function error is not proof of caller-context checking.
  globalThis.borrowedBridge = globalThis.borrowedError.includes(
    'RPC function belongs to another document context'
  )
    ? 'denied'
    : 'unexpected-error'
}
globalThis.streamError = null
try {
  parent.__bunlyStreams.send(new ArrayBuffer(1), () => {})
  globalThis.borrowedStream = 'returned-without-exception'
} catch (error) {
  globalThis.streamError = String(error).slice(0, 256)
  globalThis.borrowedStream = globalThis.streamError.includes(
    'RPC function belongs to another document context'
  )
    ? 'denied'
    : 'unexpected-error'
}
globalThis.hostileFixtureRan = true
