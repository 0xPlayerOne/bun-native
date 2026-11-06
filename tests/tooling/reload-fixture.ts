// Shared fixture for the development reload tests. The 101-remount scenarios
// live in their own files so --parallel can run them beside the other reload
// tests; every file still owns its temporary root and peer lifetime log.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createProject, readProject } from '../../scripts/native/project.ts'
import { DevSession } from '../../scripts/native/session.ts'
import { lifetimePeer } from './headless-peer.ts'

export const repository = resolve(import.meta.dir, '../..')
export let directory: string
export let peer: string
let peerLog: string

export const zeroResources = {
  application: {
    windows: 0,
    nodes: 0,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
    serviceRequests: 0,
  },
  nodes: 0,
} as const

/** Register this file's temporary root and the lifetime-recording peer. */
export function useReloadFixture(): void {
  beforeAll(() => {
    mkdirSync(join(repository, '.bun-native'), { recursive: true })
    directory = mkdtempSync(join(repository, '.bun-native/remount-test-'))
    peerLog = join(directory, 'peer-lifetimes.jsonl')
    peer = lifetimePeer(peerLog)
  }, 130_000)

  afterAll(() => rmSync(directory, { recursive: true, force: true }))
}

export function lifetimes() {
  return readFileSync(peerLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: 'started' | 'exited'; pid: number })
}

export function assertJoined(events: ReturnType<typeof lifetimes>, expected: number) {
  const alive = new Set<number>()
  let started = 0
  for (const event of events) {
    if (event.type === 'started') {
      expect(alive.size).toBe(0)
      alive.add(event.pid)
      started++
    } else expect(alive.delete(event.pid)).toBe(true)
  }
  expect(started).toBe(expected)
  expect(alive.size).toBe(0)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

/** Register the 101-remount scenario for one framework. */
export function remountTest(framework: 'solid' | 'react'): void {
  test(`joins 101 ${framework} remounts with zero owners before every replacement`, async () => {
    const path = await createProject(
      repository,
      join(directory, framework),
      framework,
      'typescript'
    )
    const project = await readProject(repository, path)
    const original = readFileSync(project.entry, 'utf8')
    const mounted = join(path, 'mounted-value')
    const start = lifetimes().length
    const session = new DevSession(repository, path, peer)
    let previous: number | undefined
    const timings: number[] = []
    try {
      for (let index = 0; index <= 101; index++) {
        writeFileSync(
          project.entry,
          original.replace(
            'await view.ready',
            `await view.ready\n  await Bun.write(${JSON.stringify(mounted)}, ${JSON.stringify(String(index))})`
          )
        )
        const result = await session.reload()
        expect(result.generation).toBe(index + 1)
        expect(readFileSync(mounted, 'utf8')).toBe(String(index))
        if (previous !== undefined) {
          expect(result.previous).toEqual({ pid: previous, clean: true, ...zeroResources })
          expect(isAlive(previous)).toBe(false)
          timings.push(result.editToReadyMs)
        }
        expect(readdirSync(session.temporaryDirectory).length).toBe(1)
        previous = result.pid
      }
    } finally {
      await session.close()
    }
    expect(isAlive(previous!)).toBe(false)
    expect(existsSync(session.temporaryDirectory)).toBe(false)
    assertJoined(lifetimes().slice(start), 102)
    expect(timings.length).toBe(101)
    timings.sort((a, b) => a - b)
    console.log(
      JSON.stringify({
        framework,
        scope: 'headless acknowledgement, not native paint',
        remounts: 101,
        medianMs: timings[Math.floor(timings.length / 2)],
        p95Ms: timings[Math.floor(timings.length * 0.95)],
        samplesMs: timings,
      })
    )
  }, 180_000)
}
