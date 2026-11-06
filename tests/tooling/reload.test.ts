import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { compileApplication } from '../../experiments/aot-gpui/compile.ts'
import * as inputs from '../../scripts/native/inputs.ts'
import { createProject, readProject } from '../../scripts/native/project.ts'
import { DevSession, type TeardownReport } from '../../scripts/native/session.ts'
import { watchProject } from '../../scripts/native/watch.ts'

const repository = resolve(import.meta.dir, '../..')
let directory: string
let peer: string
let peerLog: string
const zeroResources = {
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

beforeAll(() => {
  mkdirSync(join(repository, '.bun-native'), { recursive: true })
  directory = mkdtempSync(join(repository, '.bun-native/remount-test-'))
  peerLog = join(directory, 'peer-lifetimes.jsonl')
  writeFileSync(peerLog, '')
  const entry = join(directory, 'peer.ts')
  writeFileSync(
    entry,
    `import { appendFileSync } from 'node:fs'\nconst log = (type: string) => appendFileSync(${JSON.stringify(peerLog)}, JSON.stringify({type,pid:process.pid})+'\\n')\nlog('started')\nprocess.on('exit',()=>log('exited'))\nawait import(${JSON.stringify(join(repository, 'tests/core/protocol-peer.ts'))})\n`
  )
  peer = join(directory, process.platform === 'win32' ? 'peer.exe' : 'peer')
  compileApplication(entry, peer, repository)
}, 130_000)

afterAll(() => rmSync(directory, { recursive: true, force: true }))

function lifetimes() {
  return readFileSync(peerLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: 'started' | 'exited'; pid: number })
}

function assertJoined(events: ReturnType<typeof lifetimes>, expected: number) {
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

async function rejected(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('Expected operation to reject')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = performance.now() + 15_000
  while (!predicate()) {
    if (performance.now() >= end) throw new Error('Timed out: ' + label)
    await Bun.sleep(10)
  }
}

async function withWatcher(
  path: string,
  exercise: (watching: {
    output: string[]
    errors: string[]
    completion: Promise<void>
  }) => Promise<void>
): Promise<void> {
  const log = console.log
  const error = console.error
  const output: string[] = []
  const errors: string[] = []
  const signals = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))
  console.log = (...values: unknown[]) => {
    output.push(values.map(String).join(' '))
  }
  console.error = (...values: unknown[]) => {
    errors.push(values.map((value) => Bun.inspect(value)).join(' '))
  }
  let finished = false
  const completion = watchProject(repository, path, peer).finally(() => {
    finished = true
  })
  void completion.catch(() => {})
  try {
    await exercise({ output, errors, completion })
  } finally {
    if (!finished) process.emit('SIGTERM')
    await completion.catch(() => {})
    console.log = log
    console.error = error
    expect(['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))).toEqual(signals)
  }
}

describe('development remounts (real Bun processes and headless protocol peer, no GPUI)', () => {
  for (const framework of ['solid', 'react'] as const) {
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

  test('preserves a live app on compile error and rejects overlapping or post-close reloads', async () => {
    const path = await createProject(repository, join(directory, 'errors'), 'solid', 'typescript')
    const project = await readProject(repository, path)
    const original = readFileSync(project.entry, 'utf8')
    const session = new DevSession(repository, path, peer)
    const start = lifetimes().length
    try {
      writeFileSync(project.entry, 'const broken = <\n')
      await rejected(session.reload())
      expect(readdirSync(session.temporaryDirectory)).toEqual([])
      expect(lifetimes().slice(start)).toEqual([])
      writeFileSync(project.entry, original)
      const active = session.reload()
      expect((await rejected(session.reload())).message).toContain('already running')
      const first = await active
      writeFileSync(project.entry, 'const broken = <\n')
      await rejected(session.reload())
      expect(isAlive(first.pid)).toBe(true)
      expect(
        lifetimes()
          .slice(start)
          .map((event) => event.type)
      ).toEqual(['started'])
      expect(readdirSync(session.temporaryDirectory).length).toBe(1)
      writeFileSync(project.entry, original)
      const second = await session.reload()
      expect(second.previous).toEqual({ pid: first.pid, clean: true, ...zeroResources })
      expect(isAlive(first.pid)).toBe(false)
    } finally {
      await session.close()
    }
    expect((await rejected(session.reload())).message).toContain('closed')
    assertJoined(lifetimes().slice(start), 2)
  })

  test('closing during a build cancels replacement and removes the entire owned temporary root', async () => {
    const path = await createProject(
      repository,
      join(directory, 'cancelled'),
      'solid',
      'typescript'
    )
    const session = new DevSession(repository, path, peer)
    const start = lifetimes().length
    const active = session.reload()
    const closing = session.close()
    expect((await rejected(active)).message).toContain('closed')
    await closing
    expect(lifetimes().slice(start)).toEqual([])
    expect(existsSync(session.temporaryDirectory)).toBe(false)
  })

  test('terminates an uncooperative app within a bound and refuses another remount', async () => {
    const path = await createProject(
      repository,
      join(directory, 'uncooperative'),
      'react',
      'typescript'
    )
    const project = await readProject(repository, path)
    writeFileSync(
      project.entry,
      "process.on('message', () => {})\nprocess.send?.({ type: 'bun-native:ready' })\nsetInterval(() => {}, 1000)\n"
    )
    const session = new DevSession(repository, path, peer, 150)
    try {
      const first = await session.reload()
      const start = performance.now()
      expect((await rejected(session.reload())).message).toContain('shutdown in time')
      expect(performance.now() - start).toBeLessThan(2_000)
      expect(isAlive(first.pid)).toBe(false)
      expect((await rejected(session.reload())).message).toContain('closed')
      expect(readdirSync(session.temporaryDirectory)).toEqual([])
    } finally {
      await session.close()
    }
  })

  test('a post-ready runtime failure propagates and still removes the owned temporary root', async () => {
    const path = await createProject(
      repository,
      join(directory, 'runtime-failure'),
      'react',
      'typescript'
    )
    const project = await readProject(repository, path)
    writeFileSync(
      project.entry,
      "process.send?.({ type: 'bun-native:ready' })\nsetTimeout(() => process.exit(23), 50)\n"
    )
    const session = new DevSession(repository, path, peer)
    const ready = await session.reload()
    expect(await session.exited).toBe(1)
    expect((await rejected(session.close())).message).toContain('exit 23')
    expect(isAlive(ready.pid)).toBe(false)
    expect(existsSync(session.temporaryDirectory)).toBe(false)
  })

  test('never reports a clean stop for missing, boolean or nonzero resource counters', async () => {
    const invalid = [
      { ...zeroResources, nodes: 1 },
      { ...zeroResources, application: { ...zeroResources.application, callbacks: true } },
      { ...zeroResources, application: {} },
    ]
    for (const [index, resources] of invalid.entries()) {
      const path = await createProject(
        repository,
        join(directory, `bad-stop-${index}`),
        'solid',
        'typescript'
      )
      const project = await readProject(repository, path)
      // Keep malformed counters as imported data, never as generated JavaScript source.
      writeFileSync(
        join(path, 'teardown.json'),
        JSON.stringify({ type: 'bun-native:stopped', ...resources })
      )
      writeFileSync(
        project.entry,
        "import teardown from './teardown.json'\nprocess.on('message', () => { process.send?.(teardown); process.disconnect?.() })\nprocess.send?.({type:'bun-native:ready'})\n"
      )
      const session = new DevSession(repository, path, peer)
      const ready = await session.reload()
      expect((await rejected(session.close())).message).toContain('clean teardown')
      expect(isAlive(ready.pid)).toBe(false)
      expect(existsSync(session.temporaryDirectory)).toBe(false)
    }
  })

  test('watches imported components, retains failed edits and coalesces rapid saves', async () => {
    const path = await createProject(repository, join(directory, 'watcher'), 'solid', 'typescript')
    const project = await readProject(repository, path)
    mkdirSync(join(path, 'components'))
    const component = join(path, 'components/message.ts')
    writeFileSync(component, "export const message = 'first'\n")
    const marker = join(path, 'observed-message')
    const original = readFileSync(project.entry, 'utf8')
    writeFileSync(
      project.entry,
      "import { message } from './components/message.ts'\n" +
        original.replace(
          'await view.ready',
          `await view.ready\n  await Bun.write(${JSON.stringify(marker)}, message)\n  if (message === 'finish') setTimeout(() => { void window.close() }, 200)`
        )
    )
    const start = lifetimes().length
    await withWatcher(path, async ({ output, errors, completion }) => {
      await until(
        () => output.some((line) => line.includes('Watching project source')),
        'watcher initial readiness'
      )
      expect(readFileSync(marker, 'utf8')).toBe('first')
      mkdirSync(join(path, 'dist'))
      writeFileSync(join(path, 'dist/ignored.ts'), 'invalid syntax <\n')
      writeFileSync(join(path, 'README.md'), 'A documentation edit does not reload the app.\n')
      // A save that leaves the imported bytes unchanged still raises a file event
      // (macOS FSEvents also replays the setup writes late); only changed bytes remount.
      writeFileSync(component, readFileSync(component))
      await Bun.sleep(100)
      expect(output.filter((line) => line.startsWith('bun-native:ready ')).length).toBe(1)
      writeFileSync(component, 'export const message = <\n')
      await until(() => errors.some((line) => line.includes('message.ts')), 'syntax error feedback')
      expect(
        lifetimes()
          .slice(start)
          .map((event) => event.type)
      ).toEqual(['started'])
      for (const value of ['second', 'third', 'finish'])
        writeFileSync(component, `export const message = ${JSON.stringify(value)}\n`)
      await completion
      expect(readFileSync(marker, 'utf8')).toBe('finish')
      const reports = output
        .filter((line) => line.startsWith('bun-native:ready '))
        .map((line) => JSON.parse(line.slice('bun-native:ready '.length)) as { bundle: string })
      expect(reports.length).toBe(2)
      const stopped = output.filter((line) => line.startsWith('bun-native:stopped '))
      expect(stopped).toHaveLength(1)
      const teardown = JSON.parse(stopped[0]!.slice('bun-native:stopped '.length)) as TeardownReport
      expect(teardown).toEqual({ pid: teardown.pid, clean: true, ...zeroResources })
      expect(isAlive(teardown.pid)).toBe(false)
      for (const report of reports) expect(existsSync(dirname(dirname(report.bundle)))).toBe(false)
      expect(existsSync(join(path, '.bun-native'))).toBe(false)
      assertJoined(lifetimes().slice(start), 2)
    })
  }, 40_000)

  test('rescans events without filenames and still joins the final application', async () => {
    const path = await createProject(
      repository,
      join(directory, 'watch-missing-filename'),
      'react',
      'typescript'
    )
    const project = await readProject(repository, path)
    const original = readFileSync(project.entry, 'utf8')
    const start = lifetimes().length
    const watch = fs.watch
    let callback: unknown
    const observed = spyOn(fs, 'watch').mockImplementation((...args: unknown[]): fs.FSWatcher => {
      callback = args[2]
      // Keep the real watcher/close lifecycle while delivering only the explicit
      // event shapes below; platform-specific duplicate callbacks cannot mask it.
      return Reflect.apply(watch, fs, [args[0], args[1], () => {}])
    })
    const reload = spyOn(DevSession.prototype, 'reload')
    try {
      await withWatcher(path, async ({ output, errors, completion }) => {
        const generations = () =>
          output.filter((line) => line.startsWith('bun-native:ready ')).length
        await until(() => generations() === 1, 'initial missing-filename test generation')
        if (typeof callback !== 'function') throw new Error('Watch callback was not captured')
        for (const ignored of ['node_modules', '.git', '.bun-native', 'dist', 'build']) {
          mkdirSync(join(path, ignored))
          writeFileSync(join(path, ignored, 'ignored.ts'), 'invalid syntax <\n')
        }
        writeFileSync(join(path, 'README.md'), 'Ignored documentation edit\n')
        Reflect.apply(callback, undefined, ['rename', undefined])
        Reflect.apply(callback, undefined, ['rename', null])
        await Bun.sleep(100)
        expect(reload).toHaveBeenCalledTimes(1)
        expect(generations()).toBe(1)
        // The pinned Bun watcher can omit the filename at runtime, despite the
        // node:fs declaration advertising only string, Buffer or null.
        writeFileSync(project.entry, original.replaceAll('Bun Native React', 'Unknown event one'))
        Reflect.apply(callback, undefined, ['rename', undefined])
        await until(() => generations() === 2, 'undefined filename rescan')
        writeFileSync(project.entry, original.replaceAll('Bun Native React', 'Unknown event two'))
        Reflect.apply(callback, undefined, ['rename', null])
        await until(() => generations() === 3, 'null filename rescan')
        process.emit('SIGTERM')
        await completion
        expect(errors).toEqual([])
        expect(output.filter((line) => line.startsWith('bun-native:stopped '))).toHaveLength(1)
        assertJoined(lifetimes().slice(start), 3)
      })
    } finally {
      observed.mockRestore()
      reload.mockRestore()
    }
  }, 20_000)

  test('source edits during initial and later builds remain pending after each attempted snapshot', async () => {
    const path = await createProject(
      repository,
      join(directory, 'watch-during-build'),
      'react',
      'typescript'
    )
    const project = await readProject(repository, path)
    const original = readFileSync(project.entry, 'utf8')
    const start = lifetimes().length
    const watch = fs.watch
    let callback: unknown
    const observed = spyOn(fs, 'watch').mockImplementation((...args: unknown[]): fs.FSWatcher => {
      callback = args[2]
      return Reflect.apply(watch, fs, [args[0], args[1], () => {}])
    })
    const first = { built: false, resume: Promise.withResolvers<void>() }
    const third = { built: false, resume: Promise.withResolvers<void>() }
    const build = Bun.build
    let builds = 0
    const compiling = spyOn(Bun, 'build').mockImplementation(async (options) => {
      const result = await build(options)
      const gate = ++builds === 1 ? first : builds === 3 ? third : undefined
      if (gate) {
        gate.built = true
        await gate.resume.promise
      }
      return result
    })
    try {
      await withWatcher(path, async ({ output, errors, completion }) => {
        const generations = () => output.filter((line) => line.startsWith('bun-native:ready '))
        const edit = (title: string, filename: string | null | undefined) => {
          writeFileSync(project.entry, original.replaceAll('Bun Native React', title))
          if (typeof callback !== 'function') throw new Error('Watch callback was not captured')
          Reflect.apply(callback, undefined, ['rename', filename])
        }
        try {
          await until(() => first.built, 'initial real bundle held before mount')
          edit('Edited during initial build', undefined)
          first.resume.resolve()
          await until(() => generations().length === 2, 'pending initial-build edit')
          edit('Third generation', 'main.tsx')
          await until(() => third.built, 'third real bundle held before replacement')
          edit('Edited during replacement', null)
          third.resume.resolve()
          await until(() => generations().length === 4, 'pending replacement-build edit')
          const report = JSON.parse(generations()[3]!.slice('bun-native:ready '.length)) as {
            bundle: string
          }
          expect(readFileSync(report.bundle, 'utf8')).toContain('Edited during replacement')
          process.emit('SIGTERM')
          await completion
          expect(errors).toEqual([])
          expect(builds).toBe(4)
          assertJoined(lifetimes().slice(start), 4)
          expect(output.filter((line) => line.startsWith('bun-native:stopped '))).toHaveLength(1)
        } finally {
          first.resume.resolve()
          third.resume.resolve()
        }
      })
    } finally {
      observed.mockRestore()
      compiling.mockRestore()
    }
  }, 20_000)

  test('watch cancellation during initial build starts no application', async () => {
    const path = await createProject(
      repository,
      join(directory, 'watch-cancelled'),
      'react',
      'typescript'
    )
    const start = lifetimes().length
    await withWatcher(path, async ({ output, completion }) => {
      process.emit('SIGTERM')
      await completion
      expect(output).toEqual([])
      expect(lifetimes().slice(start)).toEqual([])
    })
  })

  test('watch cancellation joins a late scan rejection before reporting the final stopped app', async () => {
    const path = await createProject(
      repository,
      join(directory, 'watch-late-scan'),
      'react',
      'typescript'
    )
    const project = await readProject(repository, path)
    const original = readFileSync(project.entry, 'utf8')
    const start = lifetimes().length
    const events: string[] = []
    const signals = process.listenerCount('SIGTERM')
    let hold = false
    let held = false
    let scanSignal: AbortSignal | undefined
    let stream: fs.ReadStream | undefined
    const delayed = Promise.withResolvers<void>()
    const read = fs.createReadStream
    const reading = spyOn(fs, 'createReadStream').mockImplementation((filename, options) => {
      const result = read(filename, options)
      if (hold && filename === project.entry) {
        stream = result
        result.once('close', () => events.push('stream-closed'))
      }
      return result
    })
    const fingerprint = inputs.projectFingerprint
    const scanning = spyOn(inputs, 'projectFingerprint').mockImplementation(
      async (directory, signal) => {
        const value = await fingerprint(directory, signal)
        if (hold) {
          scanSignal = signal
          held = true
          events.push('scan-held')
          try {
            // Hold only the result boundary after the real file scan closes its
            // stream. Active stream cancellation is tested in watch-inputs.test.
            await delayed.promise
          } finally {
            events.push('scan-settled')
          }
        }
        return value
      }
    )
    try {
      await withWatcher(path, async ({ output, errors, completion }) => {
        let finished = false
        void completion.then(
          () => {
            finished = true
            events.push('watch-finished')
          },
          () => {}
        )
        try {
          await until(
            () => output.some((line) => line.includes('Watching project source')),
            'initial readiness before late scan'
          )
          hold = true
          writeFileSync(
            project.entry,
            original.replaceAll('Bun Native React', 'Pending source scan')
          )
          await until(() => held, 'real source scan held before settlement')
          expect(stream?.closed).toBe(true)
          process.emit('SIGTERM')
          await until(
            () => scanSignal?.aborted === true && process.listenerCount('SIGTERM') === signals,
            'watcher cleanup entered'
          )
          expect(finished).toBe(false)
          expect(output.filter((line) => line.startsWith('bun-native:stopped '))).toHaveLength(0)
          delayed.reject(new Error('Late cancelled source scan'))
          await completion
          const ready = JSON.parse(
            output
              .find((line) => line.startsWith('bun-native:ready '))!
              .slice('bun-native:ready '.length)
          ) as { pid: number; bundle: string }
          const stopped = output.filter((line) => line.startsWith('bun-native:stopped '))
          expect(stopped).toHaveLength(1)
          expect(JSON.parse(stopped[0]!.slice('bun-native:stopped '.length))).toEqual({
            pid: ready.pid,
            clean: true,
            ...zeroResources,
          })
          expect(isAlive(ready.pid)).toBe(false)
          expect(existsSync(dirname(dirname(ready.bundle)))).toBe(false)
          expect(errors).toEqual([])
          expect(events).toEqual(['stream-closed', 'scan-held', 'scan-settled', 'watch-finished'])
          assertJoined(lifetimes().slice(start), 1)
        } finally {
          delayed.resolve()
        }
      })
    } finally {
      reading.mockRestore()
      scanning.mockRestore()
    }
  }, 20_000)

  test('watch startup failure is observable and does not launch an app', async () => {
    const path = await createProject(
      repository,
      join(directory, 'watch-invalid'),
      'solid',
      'typescript'
    )
    const project = await readProject(repository, path)
    writeFileSync(project.entry, 'const invalid = <\n')
    const start = lifetimes().length
    await withWatcher(path, async ({ completion }) => {
      expect((await rejected(completion)).message).toContain('Bundle failed')
      expect(lifetimes().slice(start)).toEqual([])
    })
  })

  test('watch cancellation reports uncooperative teardown and cleans its temporary root', async () => {
    const path = await createProject(
      repository,
      join(directory, 'watch-uncooperative'),
      'react',
      'typescript'
    )
    const project = await readProject(repository, path)
    writeFileSync(
      project.entry,
      "process.on('message', () => {})\nprocess.send?.({ type: 'bun-native:ready' })\nsetInterval(() => {}, 1000)\n"
    )
    await withWatcher(path, async ({ output, completion }) => {
      await until(
        () => output.some((line) => line.includes('Watching project source')),
        'watch readiness before cancellation'
      )
      process.emit('SIGTERM')
      expect((await rejected(completion)).message).toContain('shutdown in time')
      const report = output.find((line) => line.startsWith('bun-native:ready '))!
      const { bundle, pid } = JSON.parse(report.slice('bun-native:ready '.length)) as {
        bundle: string
        pid: number
      }
      expect(existsSync(dirname(dirname(bundle)))).toBe(false)
      expect(isAlive(pid)).toBe(false)
    })
  }, 15_000)

  test('CLI --watch wires the session and exits after a generated window closes', async () => {
    const path = await createProject(
      repository,
      join(directory, 'watch-cli'),
      'react',
      'javascript'
    )
    const project = await readProject(repository, path)
    writeFileSync(
      project.entry,
      readFileSync(project.entry, 'utf8').replace(
        'await view.ready',
        'await view.ready\n  setTimeout(() => { void window.close() }, 100)'
      )
    )
    const start = lifetimes().length
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(repository, 'scripts/native.ts'),
        'dev',
        path,
        '--host',
        peer,
        '--watch',
      ],
      { cwd: repository, stdout: 'pipe', stderr: 'pipe', timeout: 10_000, maxBuffer: 1024 * 1024 }
    )
    if (child.exitCode !== 0) throw new Error(child.stdout.toString() + child.stderr.toString())
    const report = child.stdout
      .toString()
      .split('\n')
      .find((line) => line.startsWith('bun-native:ready '))
    if (!report) throw new Error('CLI did not report the ready generation')
    const { bundle } = JSON.parse(report.slice('bun-native:ready '.length)) as { bundle: string }
    expect(existsSync(dirname(dirname(bundle)))).toBe(false)
    assertJoined(lifetimes().slice(start), 1)
  }, 15_000)
})
