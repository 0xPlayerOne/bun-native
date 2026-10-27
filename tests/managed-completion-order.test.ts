import { spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import managedDesktopFixture from '../examples/managed-desktop/main.ts'
import type { ManagedResult } from '../examples/managed-desktop/evidence.ts'
import type { ManagedRestartResult } from '../examples/managed-desktop/restart-contract.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import type { NativeTerminalDriver } from '../packages/runtime/src/terminal-owner.ts'
import { nativePeer } from './helpers/native-peer.ts'

for (const [mode, rejectCleanup] of [
  ['soak', false],
  ['restart-check', false],
  ['soak', true],
  ['restart-check', true],
] as const) {
  test(`${mode} fixture waits for native shutdown after ${rejectCleanup ? 'failed' : 'successful'} cleanup`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunly-managed-completion-'))
    const resultPath = join(root, 'result.json')
    const environment = {
      BUNLY_MANAGED_MODE: mode,
      BUNLY_MANAGED_ROOT: root,
      BUNLY_SERVICE_RUNNER: fileURLToPath(
        new URL('../packages/runtime/src/service-reload-runner.ts', import.meta.url)
      ),
      BUNLY_MANAGED_ROWS: join(root, 'rows.jsonl'),
      BUNLY_MANAGED_RESULT: resultPath,
      BUNLY_MANAGED_RESTART_RESULT: resultPath,
    }
    const previous = Object.fromEntries(
      Object.keys(environment).map((name) => [name, process.env[name]])
    )
    Object.assign(process.env, environment)
    const peer = await nativePeer()
    const backend = new CefBackend(peer.transport)
    const sharedStderr = new PassThrough()
    let output = ''
    sharedStderr.on('data', (bytes: Buffer) => {
      output += bytes.toString()
    })
    const errorLog = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      sharedStderr.write(format(...args) + '\n')
    })
    let terminalSpawns = 0
    // This is an early-failure protocol test, never a native terminal or 500-reload proof.
    const driver = {
      spawn() {
        terminalSpawns++
        throw new Error('A terminal must not start in this cleanup-order test')
      },
    } as unknown as NativeTerminalDriver
    const terminalFactory = spyOn(backend, 'createTerminalDriver').mockResolvedValue(driver)
    let quitSeen!: () => void
    const quit = new Promise<void>((resolve) => {
      quitSeen = resolve
    })
    peer.handle((command) => {
      if (command.op === 'session.create') peer.reject(command, 'FIXTURE_START_REJECTED')
      else if (command.op === 'diagnostics') {
        if (rejectCleanup) {
          peer.reject(command, 'CLEANUP_PROBE_REJECTED')
          return
        }
        peer.reply(command, {
          windows: 0,
          views: 0,
          sessions: 0,
          pending: 0,
          nativeDeliveryPackets: 0,
          nativeDeliveryBytes: 0,
          rpcIncomingBytes: 0,
          streamIncomingBytes: 0,
        })
        // Model the native phase formatter writing to the inherited shared stderr.
        // The native shutdown protocol frame is sent only after this line finishes.
        sharedStderr.write('{"')
      } else if (command.op === 'quit') {
        if (rejectCleanup) sharedStderr.write('{"')
        quitSeen()
      } else peer.reply(command)
    })
    let running: Promise<unknown> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await writeFile(join(root, 'bunly-dev.json'), '{"changedNativeConfiguration":true}\n')
      running = managedDesktopFixture(backend).catch((error: unknown) => error)
      await Promise.race([
        quit,
        running.then(() => {
          throw new Error('Fixture returned before requesting native shutdown')
        }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Fixture did not request shutdown')), 2000)
        }),
      ])
      clearTimeout(deadline)
      const marker = mode === 'soak' ? 'bunly.managed-development' : 'bunly.managed-restart'
      assert.equal(output.includes(`"event":"${marker}"`), false)
      await assert.rejects(readFile(resultPath), { code: 'ENOENT' })
      assert.equal(peer.transport.diagnostics().closed, false)
      sharedStderr.write(
        'event":"bunly.host.shutdown-phase","phase":"process-stop","state":"start"}\n'
      )
      peer.send({ v: 1, event: 'shutdown' })
      const failure = await running
      assert.ok(failure instanceof Error)
      assert.equal(failure.message, 'FIXTURE_START_REJECTED')
      const lines = output
        .split('\n')
        .filter(
          (line) =>
            line.includes('"event":"bunly.host.shutdown-phase"') ||
            line.includes(`"event":"${marker}"`)
        )
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      assert.equal(lines.length, 2)
      assert.deepEqual(lines[0], {
        event: 'bunly.host.shutdown-phase',
        phase: 'process-stop',
        state: 'start',
      })
      assert.equal(lines[1]?.['event'], marker)
      assert.equal(lines[1]?.['passed'], false)
      assert.equal(lines[1]?.['failureCode'], 'FIXTURE_START_REJECTED')
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as
        | ManagedResult
        | ManagedRestartResult
      assert.equal(result.event, marker)
      assert.equal(result.passed, false)
      assert.ok(
        result.diagnostics?.entries.some(
          (entry) =>
            entry.source === 'fixture' &&
            entry.stage === 'fixture' &&
            entry.message?.text === 'FIXTURE_START_REJECTED' &&
            entry.message.redacted === false &&
            entry.message.truncated === false
        )
      )
      if (!rejectCleanup) {
        assert.equal(result.final.owner.resources, 0)
        assert.equal(result.final.owner.generations, 0)
      }
      assert.equal(result.final.broker.closed, true)
      assert.equal(result.final.broker.generations, 0)
      assert.equal(result.requests.pending, 0)
      assert.equal(peer.transport.failure, null)
      assert.equal(peer.transport.diagnostics().requests, 0)
      assert.equal(terminalSpawns, 0)
    } finally {
      clearTimeout(deadline)
      try {
        await peer.stop()
        await running
        await backend.dispose()
      } finally {
        terminalFactory.mockRestore()
        errorLog.mockRestore()
        sharedStderr.destroy()
        peer.input.destroy()
        peer.output.destroy()
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
        await rm(root, { recursive: true, force: true })
      }
    }
  })
}
