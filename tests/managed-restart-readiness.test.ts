import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import managedRestartFixture from '../examples/managed-desktop/restart.ts'
import {
  RESTART_DEADLINE_MS,
  restartRpcLimits,
} from '../examples/managed-desktop/restart-contract.ts'
import { rpcLimits } from '../packages/contracts/src/rpc.ts'
import { encodeRpc } from '../packages/contracts/src/rpc-wire.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

for (const ordering of [
  'renderer-first',
  'native-during-creation',
  'deadline-before-native',
] as const) {
  test(`restart waits for native document readiness with ${ordering}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunly-restart-readiness-'))
    const resultPath = join(root, 'result.json')
    const environment = {
      BUNLY_MANAGED_ROOT: root,
      BUNLY_SERVICE_RUNNER: fileURLToPath(
        new URL('../packages/runtime/src/service-reload-runner.ts', import.meta.url)
      ),
      BUNLY_MANAGED_RESTART_RESULT: resultPath,
    }
    const previous = Object.fromEntries(
      Object.keys(environment).map((name) => [name, process.env[name]])
    )
    Object.assign(process.env, environment)
    const peer = await nativePeer()
    const backend = new CefBackend(peer.transport)
    const log = spyOn(console, 'error').mockImplementation(() => {})
    let expireFixture: (() => void) | undefined
    const schedule = globalThis.setTimeout
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(
      Object.assign(
        (callback: TimerHandler, delay?: number, ...args: unknown[]) => {
          if (delay === RESTART_DEADLINE_MS && typeof callback === 'function')
            expireFixture = () => Reflect.apply(callback, undefined, args)
          return Reflect.apply(schedule, globalThis, [callback, delay, ...args])
        },
        { __promisify__: schedule.__promisify__ }
      ) as typeof globalThis.setTimeout
    )
    const created = deferred(),
      beginAccepted = deferred()
    let next = 0,
      captures = 0,
      nativeReady = false
    const loaded = (target = 3, documentId = 'native-3-1') => {
      peer.send({
        v: 1,
        event: 'view.loaded',
        target,
        data: { url: 'app://ui/restart.html', status: 200, documentId },
      })
    }
    peer.handle((command) => {
      if (command.op.endsWith('.create')) {
        peer.reply(command, { id: ++next })
        if (command.op === 'view.create') {
          if (ordering === 'native-during-creation') {
            nativeReady = true
            loaded()
          }
          created.resolve()
        }
      } else if (command.op === 'policy.scope') {
        captures++
        // Stop at the real native authority boundary; this is an ordering test,
        // not a replacement Worker or native CEF acceptance substitute.
        peer.reject(
          command,
          nativeReady
            ? 'POLICY_SCOPE_PROBE_REJECTED'
            : 'view has no ready native document authority'
        )
      } else if (command.op === 'diagnostics') {
        peer.reply(command, {
          windows: 1,
          views: 0,
          sessions: 0,
          pending: 0,
          nativeDeliveryPackets: 0,
          nativeDeliveryBytes: 0,
          rpcIncomingBytes: 0,
          streamIncomingBytes: 0,
        })
      } else {
        peer.reply(command)
        if (command.op === 'rpc.ack') beginAccepted.resolve()
        if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
      }
    })
    let running: Promise<unknown> | undefined
    try {
      await writeFile(join(root, 'bunly-dev.json'), '{"changedNativeConfiguration":true}\n')
      running = managedRestartFixture(backend).catch((error: unknown) => error)
      await created.promise
      await turn()
      peer.send({
        v: 1,
        event: 'rpc.connected',
        target: 3,
        data: {
          connection: 4,
          context: 1,
          frameId: 'native-main',
          documentId: 'native-3-1',
          generation: 1,
          origin: 'app://ui',
        },
      })
      await turn()
      const packet = encodeRpc(
        {
          type: 'request',
          id: 1,
          method: 'begin',
          timeoutMs: 1000,
          value: {
            instance: 'fresh-renderer',
            formEmpty: true,
            sessionAbsent: true,
            loginAbsent: true,
          },
        },
        rpcLimits(restartRpcLimits)
      )
      peer.send({
        v: 1,
        event: 'rpc.packet',
        target: 3,
        data: {
          connection: 4,
          context: 1,
          generation: 1,
          sequence: 1,
          packet: Buffer.from(packet).toString('hex'),
          copiedBytes: packet.byteLength,
        },
      })
      await beginAccepted.promise
      await turn()
      if (ordering !== 'native-during-creation') {
        expect(captures).toBe(0)
        loaded(99, 'native-99-1')
        await turn()
        expect(captures).toBe(0)
        if (ordering === 'deadline-before-native') {
          expect(expireFixture).toBeFunction()
          expireFixture!()
        } else {
          nativeReady = true
          loaded()
        }
      }
      const failure =
        ordering === 'deadline-before-native'
          ? 'RESTART_FIXTURE_DEADLINE'
          : 'POLICY_SCOPE_PROBE_REJECTED'
      expect(await running).toEqual(new Error(failure))
      expect(captures).toBe(ordering === 'deadline-before-native' ? 0 : 1)
      const result = JSON.parse(await readFile(resultPath, 'utf8'))
      expect(result.passed).toBe(false)
      expect(result.failureCode).toBe(failure)
      expect(result.requests).toEqual({ accepted: 1, settled: 1, pending: 0 })
      expect(result.diagnostics.entries).toContainEqual({
        source: 'fixture',
        event: 'failure',
        stage: 'fixture',
        message: { text: failure, redacted: false, truncated: false },
      })
      expect(backend.diagnostics().listeners).toBe(0)
    } finally {
      await peer.stop()
      await running
      await backend.dispose().catch(() => {})
      timers.mockRestore()
      log.mockRestore()
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })
}
