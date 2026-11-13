import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileApplication } from '../../scripts/native/compile.ts'
import { observeTemplate } from '../native/cli-template-owner.ts'

const repository = resolve(import.meta.dir, '../..')
let directory: string
let serial = 0
const clean = {
  type: 'bun-native:stopped',
  nodes: 0,
  application: {
    windows: 0,
    nodes: 0,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
    serviceRequests: 0,
  },
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'bun-native-template-owner-'))
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function program(body: string) {
  const path = join(directory, `application-${serial++}.ts`)
  writeFileSync(path, body)
  return path
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('template IPC evidence owner (headless; no native rendering or input)', () => {
  test('joins development and inspected AOT IPC, recording the actual unchanged files', async () => {
    const entry = program(
      `process.send?.({ type: 'bun-native:ready' })\nprocess.send?.(${JSON.stringify(clean)})\nprocess.disconnect?.()\n`
    )
    const executable = join(
      directory,
      process.platform === 'win32' ? 'application.exe' : 'application'
    )
    const compiled = compileApplication(entry, executable, repository)
    expect(compiled.inspection.hasCompiledProgram).toBe(true)
    expect(compiled.runtimeFeatures.jit).not.toBe('present')
    for (const command of [[process.execPath, entry], [executable]]) {
      const signals = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))
      const report = await observeTemplate(command, process.env, [entry, executable])
      expect(report.status).toBe('passed')
      expect(report.ready_count).toBe(1)
      expect(report.stopped_count).toBe(1)
      expect(report.final_resources).toEqual(clean)
      expect(report.zero_resources).toBe(true)
      expect(report.ipc_disconnected).toBe(true)
      expect(report.process_joined).toBe(true)
      expect(report.forced_termination).toBe(false)
      expect(report.artifacts_unchanged).toBe(true)
      expect(report.artifacts).toHaveLength(2)
      expect(report.artifacts[0]?.sha256).toBe(
        Bun.CryptoHasher.hash('sha256', readFileSync(entry), 'hex')
      )
      expect(alive(report.pid)).toBe(false)
      expect(['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))).toEqual(signals)
    }
  }, 130_000)

  test('fails missing, malformed, duplicated, reordered, nonzero and unclean shutdown records', async () => {
    const invalid = [
      [],
      [null],
      [{ type: 'bun-native:ready' }, { ...clean, nodes: 1 }],
      [
        { type: 'bun-native:ready' },
        { ...clean, application: { ...clean.application, windows: 1 } },
      ],
      [{ type: 'bun-native:ready' }, { ...clean, application: [] }],
      [clean, { type: 'bun-native:ready' }],
      [{ type: 'bun-native:ready' }, { type: 'bun-native:ready' }, clean],
      [{ type: 'bun-native:ready' }, clean, clean],
    ]
    for (const records of invalid) {
      const entry = program(
        `${records.map((value) => `process.send?.(${JSON.stringify(value)})`).join('\n')}\nprocess.disconnect?.()\n`
      )
      const report = await observeTemplate([process.execPath, entry], process.env, [entry])
      expect(report.status).toBe('failed')
      expect(report.error).toBeDefined()
      expect(report.process_joined).toBe(true)
      expect(alive(report.pid)).toBe(false)
    }
    const entry = program(
      `process.send?.({type:'bun-native:ready'})\nprocess.send?.(${JSON.stringify(clean)})\nprocess.disconnect?.()\nprocess.exitCode=23\n`
    )
    const failed = await observeTemplate([process.execPath, entry], process.env, [])
    expect(failed.status).toBe('failed')
    expect(failed.exit_code).toBe(23)
  })

  test('does not accept changed source as unchanged execution evidence', async () => {
    const marker = join(directory, 'fingerprinted-source.ts')
    writeFileSync(marker, 'before')
    const entry = program(
      `await Bun.write(${JSON.stringify(marker)}, 'after')\nprocess.send?.({type:'bun-native:ready'})\nprocess.send?.(${JSON.stringify(clean)})\nprocess.disconnect?.()\n`
    )
    const report = await observeTemplate([process.execPath, entry], process.env, [marker])
    expect(report.status).toBe('failed')
    expect(report.artifacts_unchanged).toBe(false)
    expect(report.error).toContain('changed')
  })

  test('bounds an uncooperative child and never counts forced cleanup as passing', async () => {
    const entry = program(
      "process.on('SIGTERM', () => {})\nprocess.on('message', () => {})\nprocess.send?.({type:'bun-native:ready'})\nsetInterval(() => {}, 1000)\n"
    )
    const report = await observeTemplate([process.execPath, entry], process.env, [entry], 300)
    expect(report.status).toBe('failed')
    expect(report.error).toContain('deadline')
    expect(report.forced_termination).toBe(true)
    expect(report.ipc_disconnected).toBe(true)
    expect(report.elapsed_ms).toBeLessThan(4_000)
    expect(alive(report.pid)).toBe(false)
  }, 5_000)

  test('cancellation joins its own app and restores owner signal listeners', async () => {
    const marker = join(directory, 'ready')
    const entry = program(
      `process.on('message', () => {})\nprocess.send?.({type:'bun-native:ready'})\nawait Bun.write(${JSON.stringify(marker)}, 'ready')\nsetInterval(() => {}, 1000)\n`
    )
    const signals = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))
    const active = observeTemplate([process.execPath, entry], process.env, [entry])
    const deadline = performance.now() + 3_000
    while (!existsSync(marker) && performance.now() < deadline) await Bun.sleep(10)
    expect(existsSync(marker)).toBe(true)
    process.emit('SIGTERM')
    const report = await active
    expect(report.status).toBe('failed')
    expect(report.error).toContain('interrupted')
    expect(report.process_joined).toBe(true)
    expect(alive(report.pid)).toBe(false)
    expect(['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))).toEqual(signals)
  })

  test('rejects an absent command or invalid bound before launching anything', async () => {
    expect(observeTemplate([], process.env, [])).rejects.toThrow('command')
    expect(observeTemplate([process.execPath], process.env, [], 0)).rejects.toThrow('timeout')
    expect(observeTemplate([process.execPath], process.env, [], 35_001)).rejects.toThrow('timeout')
  })
})
