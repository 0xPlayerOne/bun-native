import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createProject, type Framework, type Language } from '../../scripts/native/project.ts'
import { observeDevelopmentTemplate } from '../native/cli-dev-owner.ts'
import { lifetimePeer } from './headless-peer.ts'

const repository = resolve(import.meta.dir, '../..')
let directory: string
let peer: string
let peerLog: string
let serial = 0

async function source(framework: Framework, language: Language) {
  const path = join(directory, `source-${serial++}`)
  const retained = join(directory, `retained-${serial}`)
  await createProject(repository, path, framework, language)
  const entry = join(path, language === 'typescript' ? 'main.tsx' : 'main.jsx')
  // Headless lifecycle control only. Native qualification uses the untouched
  // prepared source and requires the independent X11 driver to close the window.
  writeFileSync(
    entry,
    readFileSync(entry, 'utf8').replace(
      'await Promise.race([window.closed, view.closed, stopped.promise])',
      `const deadline = performance.now() + 2_000
  while (!(await Bun.file(${JSON.stringify(join(retained, 'application.js'))}).exists())) {
    if (performance.now() > deadline) throw new Error('Headless fixture did not observe module capture')
    await Bun.sleep(5)
  }
  await window.close()`
    )
  )
  return { path, entry, retained }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform !== 'linux')(
  'exact native dev owner (real CLI and headless peer; no GUI acceptance)',
  () => {
    beforeAll(() => {
      mkdirSync(join(repository, '.bun-native'), { recursive: true })
      directory = mkdtempSync(join(repository, '.bun-native/cli-dev-owner-test-'))
      peerLog = join(directory, 'peer.jsonl')
      peer = lifetimePeer(peerLog)
    }, 130_000)

    afterAll(() => rmSync(directory, { recursive: true, force: true }))

    for (const framework of ['solid', 'react'] as const) {
      for (const language of ['typescript', 'javascript'] as const) {
        test(`observes and joins ${framework} ${language} without Cargo/Rust`, async () => {
          const prepared = await source(framework, language)
          const retained = prepared.retained
          const before = readFileSync(peerLog, 'utf8').length
          const report = await observeDevelopmentTemplate(
            prepared.path,
            peer,
            retained,
            process.env,
            [peer]
          )
          expect(report.status).toBe('passed')
          expect(report.command).toEqual([
            process.execPath,
            join(repository, 'scripts/native.ts'),
            'dev',
            report.generated_project.path,
            '--host',
            peer,
          ])
          expect(report.cwd).not.toBe(repository)
          expect(report.cwd).not.toBe(report.generated_project.path)
          expect(report.ready_count).toBe(1)
          expect(report.stopped_count).toBe(1)
          expect(report.zero_resources).toBe(true)
          expect(report.process_joined && report.ipc_disconnected).toBe(true)
          expect(report.forced_termination).toBe(false)
          expect(report.artifacts_unchanged).toBe(true)
          expect(
            report.development_module?.artifacts.some((file) =>
              file.path.endsWith('/application.js')
            )
          ).toBe(true)
          expect(existsSync(join(retained, 'application.js'))).toBe(true)
          expect(report.temporary_modules_after_exit).toEqual([])
          expect(report.no_native_tools_invoked).toBe(true)
          expect(report.native_tool_invocations).toBe('')
          expect(report.native_tool_sentinels).toHaveLength(3)
          expect(report.owned_directory_removed).toBe(true)
          expect(existsSync(report.owned_directory)).toBe(false)
          expect(alive(report.pid)).toBe(false)
          const lifetimes = readFileSync(peerLog, 'utf8')
            .slice(before)
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { type: string; pid: number })
          expect(lifetimes.map((event) => event.type)).toEqual(['started', 'exited'])
          expect(lifetimes[0]?.pid).toBe(lifetimes[1]?.pid)
          expect(alive(lifetimes[0]!.pid)).toBe(false)
        }, 15_000)
      }
    }

    test('a real PATH tool invocation fails qualification despite clean app shutdown', async () => {
      const prepared = await source('react', 'typescript')
      writeFileSync(
        prepared.entry,
        "Bun.spawnSync(['cargo', '--version'])\n" + readFileSync(prepared.entry, 'utf8')
      )
      const report = await observeDevelopmentTemplate(
        prepared.path,
        peer,
        prepared.retained,
        process.env,
        [peer]
      )
      expect(report.status).toBe('failed')
      expect(report.zero_resources).toBe(true)
      expect(report.error).toContain('sentinel')
      expect(report.no_native_tools_invoked).toBe(false)
      expect(report.native_tool_invocations.trim()).toEndWith('/cargo')
      expect(report.owned_directory_removed).toBe(true)
      expect(alive(report.pid)).toBe(false)
    })

    test('compile failure leaves no generated project or temporary module', async () => {
      const prepared = await source('solid', 'typescript')
      writeFileSync(prepared.entry, 'const broken = <\n')
      const retained = prepared.retained
      const report = await observeDevelopmentTemplate(prepared.path, peer, retained, process.env, [
        peer,
      ])
      expect(report.status).toBe('failed')
      expect(report.ready_count).toBe(0)
      expect(report.development_module).toBeUndefined()
      expect(report.temporary_modules_after_exit).toEqual([])
      expect(report.owned_directory_removed).toBe(true)
      expect(existsSync(retained)).toBe(false)
      expect(alive(report.pid)).toBe(false)
    })
  }
)
