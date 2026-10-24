import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { waitForCefLoopbackTransport } from '../../packages/client/src/cef-loopback.ts'
import { RpcLoopbackTransport } from '../../packages/client/src/rpc-loopback.ts'
import {
  decodeNativeLoopbackHandoff,
  encodeNativeLoopbackConfirmation,
} from '../../packages/contracts/src/rpc-native-handoff.ts'
import { RPC_TRANSPORT_WORKLOAD, transportLimits, transportSchema } from './transport-contract.ts'

const params = new URL(location.href).searchParams
const candidate = params.get('candidate')
const role = params.get('role') ?? 'main'
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const select = () =>
  candidate === 'authenticated-loopback' ? waitForCefLoopbackTransport() : waitForCefRpcTransport()
try {
  check(
    candidate === 'native-mediated' || candidate === 'authenticated-loopback',
    'Invalid candidate'
  )
  if (role === 'unprivileged') {
    try {
      await waitForCefRpcTransport(100)
      throw new Error('Revoked document received native bridge')
    } catch (error) {
      check(
        error instanceof Error && 'code' in error && error.code === 'DEADLINE_EXCEEDED',
        'Unexpected unprivileged error'
      )
      console.log('BUNLY_TRANSPORT_UNPRIVILEGED')
    }
  } else if (role === 'attack-owner' || role === 'attack-foreign') {
    check(candidate === 'authenticated-loopback', 'Attack requires loopback')
    const native = await waitForCefRpcTransport()
    const channel = new BroadcastChannel('bunly-native-confirmation-fixture')
    let ownOffer = false,
      finished = false
    const cleanup = () => {
      channel.close()
      native.close()
    }
    addEventListener('pagehide', cleanup, { once: true })
    if (role === 'attack-foreign') {
      channel.onmessage = (event) => {
        if (finished || !ownOffer) return
        finished = true
        const offer = event.data as { endpoint: string; credential: Uint8Array }
        const stolen = new RpcLoopbackTransport({
          ...offer,
          maxFrameBytes: 96 * 1024,
          confirmNative: async (challenge) => {
            await native.send(encodeNativeLoopbackConfirmation(challenge))
          },
        })
        const client = new RpcClient(transportSchema, stolen, { limits: transportLimits })
        void client
          .call('structured', { index: 0, label: 'must-not-run' })
          .then(
            () => console.error('BUNLY_TRANSPORT_FAILED:stolen credential admitted'),
            () => console.log('BUNLY_TRANSPORT_ATTACK_DENIED')
          )
          .finally(() => {
            client.close()
            cleanup()
          })
      }
    }
    native.subscribe(
      (packet) => {
        check(!ownOffer, 'Duplicate attack offer')
        ownOffer = true
        const offer = decodeNativeLoopbackHandoff(packet)
        if (role === 'attack-owner') channel.postMessage(offer)
        else console.log('BUNLY_TRANSPORT_ATTACK_READY')
        offer.credential.fill(0)
      },
      () => {
        if (role === 'attack-owner' && !finished) finished = true
      }
    )
  } else {
    addEventListener('securitypolicyviolation', (event) =>
      console.error(
        'BUNLY_TRANSPORT_CSP:' +
          (event as SecurityPolicyViolationEvent).violatedDirective +
          ':' +
          (event as SecurityPolicyViolationEvent).blockedURI
      )
    )
    const begin = performance.now()
    const client = new RpcClient(transportSchema, await select(), { limits: transportLimits })
    addEventListener('pagehide', () => client.close(), { once: true })
    if (role === 'revoke') {
      void client.call('hold', 'navigate', { timeoutMs: 15000 }).then(
        () => console.error('BUNLY_TRANSPORT_FAILED:late navigation result'),
        () => console.log('BUNLY_TRANSPORT_NAVIGATION_ABORTED')
      )
      check(
        (await client.call('holdState', 'navigate')) === 'started',
        'Navigation hold not admitted'
      )
      console.log('BUNLY_TRANSPORT_NAVIGATION_STARTED')
    } else {
      check(role === 'main', 'Unknown transport role')
      const handoff = await client.call('structured', { index: 0, label: 'handoff' })
      check(handoff.label === 'handoff', 'First response mismatch')
      const handoffMs = performance.now() - begin
      const structuredStart = performance.now()
      for (
        let offset = 0;
        offset < RPC_TRANSPORT_WORKLOAD.structuredCalls;
        offset += RPC_TRANSPORT_WORKLOAD.structuredConcurrency
      ) {
        const count = Math.min(
          RPC_TRANSPORT_WORKLOAD.structuredConcurrency,
          RPC_TRANSPORT_WORKLOAD.structuredCalls - offset
        )
        const results = await Promise.all(
          Array.from({ length: count }, (_, index) =>
            client.call('structured', { index: offset + index, label: 'timed' })
          )
        )
        check(
          results.every(
            (value, index) => value.index === offset + index && value.label === 'timed'
          ),
          'Structured correctness'
        )
      }
      const structuredMs = performance.now() - structuredStart
      const bytes = Uint8Array.from(
        { length: RPC_TRANSPORT_WORKLOAD.binaryBytesPerCall },
        (_, index) => index & 255
      )
      const binaryStart = performance.now()
      for (let call = 0; call < RPC_TRANSPORT_WORKLOAD.binaryCalls; call++) {
        const result = await client.call('binary', bytes)
        check(result.length === bytes.length, 'Binary length')
        for (let index = 0; index < result.length; index++)
          check(result[index] === bytes[index], 'Binary byte mismatch')
      }
      const binaryMs = performance.now() - binaryStart
      const cancellationStart = performance.now()
      for (let index = 0; index < RPC_TRANSPORT_WORKLOAD.cancellationCalls; index++) {
        const controller = new AbortController()
        const call = client.call('cancel', index, { signal: controller.signal }).then(
          () => {
            throw new Error('Cancelled call succeeded')
          },
          (error) => error as { code?: unknown }
        )
        check(
          (await client.call('cancelState', index)) === 'started',
          'Cancellation preceded admission'
        )
        controller.abort()
        check((await call).code === 'CANCELLED', 'Wrong cancellation result')
        check(
          (await client.call('cancelState', index)) === 'aborted',
          'Backend did not observe cancellation'
        )
      }
      const cancellationMs = performance.now() - cancellationStart
      const throttle = client.call('barrier', 'throttle', { timeoutMs: 15000 })
      console.log('BUNLY_TRANSPORT_THROTTLE_READY')
      check((await throttle) === 'throttled', 'Missing native throttle acknowledgement')
      const throttledStart = performance.now()
      for (let index = 0; index < 20; index++) {
        const result = await client.call('structured', { index, label: 'throttled' })
        check(result.index === index && result.label === 'throttled', 'Throttled correctness')
      }
      const throttledMs = performance.now() - throttledStart
      const restore = client.call('barrier', 'restore', { timeoutMs: 15000 })
      console.log('BUNLY_TRANSPORT_RESTORE_READY')
      check((await restore) === 'restored', 'Missing native throttle restoration')
      const diagnostics = client.diagnostics()
      await client.call('report', {
        handoffMs,
        structuredMs,
        binaryMs,
        cancellationMs,
        throttledMs,
        clientFrames: diagnostics.peakQueuedFrames,
        clientBytes: diagnostics.peakQueuedBytes,
      })
      console.log('BUNLY_TRANSPORT_WORK_DONE')
      const disconnected = client.call('hold', 'disconnect', { timeoutMs: 30000 }).then(
        () => {
          throw new Error('Disconnected call succeeded')
        },
        (error) => error as { code?: unknown }
      )
      check(
        (await client.call('holdState', 'disconnect')) === 'started',
        'Disconnect hold not admitted'
      )
      console.log('BUNLY_TRANSPORT_DISCONNECT_STARTED')
      check(
        ['DISCONNECTED', 'REVOKED'].includes(String((await disconnected).code)),
        'Wrong disconnect result'
      )
      check(client.diagnostics().pending === 0, 'Pending calls survived disconnect')
      client.close()
      console.log('BUNLY_TRANSPORT_DISCONNECTED')
    }
  }
} catch (error) {
  console.error('BUNLY_TRANSPORT_FAILED:' + String(error))
}
