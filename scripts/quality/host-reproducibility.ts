#!/usr/bin/env bun
// Records and compares independent builds of the release native host (#223).
//
// `.github/workflows/host-reproducibility.yml` builds `bun-native-host` twice per
// operating system, each time on its own hosted runner with no restored build
// outputs, and every job calls `record`. The final job calls `compare`. A host is
// reproducible across runners only when both independent builds of one commit
// have the same SHA-256, so the comparison never trusts a single build.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { explainDifference, renderDifference } from './binary-diff.ts'

export type Attempt = 'a' | 'b'

export type HostRecord = {
  schemaVersion: 1
  os: string
  arch: string
  attempt: Attempt
  commit: string
  hostFile: string
  hostBytes: number
  hostSha256: string
  archiveSha256: string
  /** Toolchain and image strings that explain a mismatch (rustc, linker, SDK, runner image). */
  tools: Record<string, string>
}

export type OsResult = {
  os: string
  status: 'identical' | 'different' | 'incomplete'
  required: boolean
  detail: string
  records: HostRecord[]
}

export type Comparison = { commit: string | null; ok: boolean; results: OsResult[] }

const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `name=value` pairs, split at the first `=` so values may contain `=`. */
export function parseTools(pairs: string[]): Record<string, string> {
  const tools: Record<string, string> = {}
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) throw new Error(`--tool must be name=value: ${pair}`)
    const name = pair.slice(0, at)
    if (Object.hasOwn(tools, name)) throw new Error(`Duplicate --tool ${name}`)
    tools[name] = pair.slice(at + 1)
  }
  return tools
}

export function buildRecord(input: {
  os: string
  arch: string
  attempt: string
  commit: string
  hostFile: string
  host: Uint8Array
  archive: Uint8Array
  tools: Record<string, string>
}): HostRecord {
  if (input.attempt !== 'a' && input.attempt !== 'b') throw new Error('attempt must be a or b')
  if (!COMMIT.test(input.commit)) throw new Error('commit must be a 40-digit lowercase SHA-1')
  if (!input.os || !input.arch) throw new Error('os and arch are required')
  if (input.host.length === 0) throw new Error('The host executable is empty')
  return {
    schemaVersion: 1,
    os: input.os,
    arch: input.arch,
    attempt: input.attempt,
    commit: input.commit,
    hostFile: input.hostFile,
    hostBytes: input.host.length,
    hostSha256: sha256(input.host),
    archiveSha256: sha256(input.archive),
    tools: input.tools,
  }
}

export function parseRecord(text: string, what: string): HostRecord {
  const value = JSON.parse(text) as Partial<HostRecord>
  const fail = (reason: string): never => {
    throw new Error(`${what}: ${reason}`)
  }
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (typeof value.os !== 'string' || !value.os) fail('os is required')
  if (typeof value.arch !== 'string' || !value.arch) fail('arch is required')
  if (value.attempt !== 'a' && value.attempt !== 'b') fail('attempt must be a or b')
  if (typeof value.commit !== 'string' || !COMMIT.test(value.commit)) fail('commit is invalid')
  if (typeof value.hostSha256 !== 'string' || !SHA256.test(value.hostSha256))
    fail('hostSha256 is invalid')
  if (typeof value.archiveSha256 !== 'string' || !SHA256.test(value.archiveSha256))
    fail('archiveSha256 is invalid')
  if (!Number.isSafeInteger(value.hostBytes) || (value.hostBytes ?? 0) <= 0)
    fail('hostBytes is invalid')
  if (typeof value.hostFile !== 'string' || !value.hostFile) fail('hostFile is required')
  if (typeof value.tools !== 'object' || value.tools === null || Array.isArray(value.tools))
    fail('tools must be an object')
  return value as HostRecord
}

/**
 * Groups records by operating system and decides each one. An OS needs exactly one
 * record per attempt, from one commit, to be decided at all; a missing or repeated
 * attempt is `incomplete`, never `identical`. Only `required` operating systems
 * affect `ok`, so a newly measured platform can be reported before it is gated.
 */
export function compareRecords(records: HostRecord[], required: string[]): Comparison {
  const commits = new Set(records.map((record) => record.commit))
  const byOs = new Map<string, HostRecord[]>()
  for (const record of records) byOs.set(record.os, [...(byOs.get(record.os) ?? []), record])
  for (const os of required) if (!byOs.has(os)) byOs.set(os, [])
  const results: OsResult[] = []
  for (const os of [...byOs.keys()].sort()) {
    const group = byOs.get(os) ?? []
    const attempts = group.map((record) => record.attempt).sort()
    const isRequired = required.includes(os)
    let status: OsResult['status']
    let detail: string
    if (attempts.join('') !== 'ab') {
      status = 'incomplete'
      detail = `needs one record per attempt, found [${attempts.join(', ')}]`
    } else {
      const [first, second] = group.sort((x, y) => (x.attempt < y.attempt ? -1 : 1)) as [
        HostRecord,
        HostRecord,
      ]
      if (first.commit !== second.commit) {
        status = 'incomplete'
        detail = 'the two builds are from different commits'
      } else if (first.arch !== second.arch) {
        status = 'incomplete'
        detail = `the two builds have different architectures (${first.arch}, ${second.arch})`
      } else if (first.hostSha256 !== second.hostSha256) {
        status = 'different'
        detail = `${first.hostSha256} (${first.hostBytes} bytes) vs ${second.hostSha256} (${second.hostBytes} bytes)`
      } else if (first.archiveSha256 !== second.archiveSha256) {
        status = 'different'
        detail = `host ${first.hostSha256} is identical, but the archives differ`
      } else {
        status = 'identical'
        detail = `${first.hostSha256} (${first.hostBytes} bytes)`
      }
    }
    results.push({ os, status, required: isRequired, detail, records: group })
  }
  const sameCommit = commits.size <= 1
  return {
    commit: sameCommit ? ([...commits][0] ?? null) : null,
    ok: sameCommit && results.every((result) => !result.required || result.status === 'identical'),
    results,
  }
}

/** Every differing tool string between the two builds of an operating system. */
export function toolDifferences(result: OsResult): string[] {
  if (result.records.length !== 2) return []
  const [first, second] = result.records as [HostRecord, HostRecord]
  const names = [...new Set([...Object.keys(first.tools), ...Object.keys(second.tools)])].sort()
  return names
    .filter((name) => first.tools[name] !== second.tools[name])
    .map(
      (name) => `${name}: ${first.tools[name] ?? '(unset)'} | ${second.tools[name] ?? '(unset)'}`
    )
}

export function renderMarkdown(comparison: Comparison): string {
  const lines = [
    `Source commit: ${comparison.commit ?? 'MIXED OR MISSING'}`,
    '',
    '| OS | Gate | Result | Detail |',
    '| -- | ---- | ------ | ------ |',
  ]
  for (const result of comparison.results)
    lines.push(
      `| ${result.os} | ${result.required ? 'required' : 'measured only'} | ${result.status} | ${result.detail} |`
    )
  for (const result of comparison.results) {
    const differences = toolDifferences(result)
    if (differences.length > 0)
      lines.push(
        '',
        `Tool or image differences on ${result.os}:`,
        ...differences.map((d) => `- ${d}`)
      )
  }
  lines.push(
    '',
    comparison.ok ? 'Required operating systems are reproducible.' : 'FAILED: see above.'
  )
  return lines.join('\n')
}

function collectRecordFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) files.push(...collectRecordFiles(path))
    else if (entry.endsWith('.host-record.json')) files.push(path)
  }
  return files.sort()
}

export function loadRecords(directory: string): HostRecord[] {
  return collectRecordFiles(directory).map((file) => parseRecord(readFileSync(file, 'utf8'), file))
}

function findFile(directory: string, name: string): string | null {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name)
      if (found) return found
    } else if (entry === name) return path
  }
  return null
}

/**
 * Markdown lines naming the differing bytes of each operating system whose two
 * builds differ, when both executables (`<os>-<attempt>.host`) were uploaded
 * beside the records.
 */
export function explainDifferences(directory: string, comparison: Comparison): string[] {
  const lines: string[] = []
  for (const result of comparison.results) {
    if (result.status !== 'different') continue
    const [a, b] = (['a', 'b'] as const).map((attempt) =>
      findFile(directory, `${result.os}-${attempt}.host`)
    )
    if (!a || !b) {
      lines.push('', `Byte differences on ${result.os}: executables were not uploaded.`)
      continue
    }
    lines.push(...renderDifference(result.os, explainDifference(readFileSync(a), readFileSync(b))))
  }
  return lines
}

/** The command line; returns the exit code. Exported so tests cover it in process. */
export function main(argv: string[], log: (line: string) => void = console.log): number {
  const [command, ...rest] = argv
  const usage =
    'usage: host-reproducibility.ts record --host H --archive A --out F --os OS --arch ARCH --attempt a|b --commit SHA [--tool name=value]...\n' +
    '       host-reproducibility.ts compare DIRECTORY [--require linux,macos,windows] [--output result.json]'
  if (command === 'record') {
    const { values } = parseArgs({
      args: rest,
      options: {
        host: { type: 'string' },
        archive: { type: 'string' },
        out: { type: 'string' },
        os: { type: 'string' },
        arch: { type: 'string' },
        attempt: { type: 'string' },
        commit: { type: 'string' },
        tool: { type: 'string', multiple: true },
      },
    })
    for (const key of ['host', 'archive', 'out', 'os', 'arch', 'attempt', 'commit'] as const)
      if (!values[key]) throw new Error(`--${key} is required\n${usage}`)
    for (const key of ['host', 'archive', 'out'] as const)
      if (!isAbsolute(values[key] as string)) throw new Error(`--${key} must be absolute`)
    const record = buildRecord({
      os: values.os as string,
      arch: values.arch as string,
      attempt: values.attempt as string,
      commit: values.commit as string,
      hostFile: (values.host as string).split(/[\\/]/).pop() as string,
      host: readFileSync(values.host as string),
      archive: readFileSync(values.archive as string),
      tools: parseTools(values.tool ?? []),
    })
    writeFileSync(values.out as string, `${JSON.stringify(record, null, 2)}\n`)
    log(`${record.os}/${record.attempt} host ${record.hostSha256} (${record.hostBytes} bytes)`)
    return 0
  } else if (command === 'compare') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        require: { type: 'string', default: 'linux,macos,windows' },
        output: { type: 'string' },
      },
    })
    const [directory] = positionals
    if (!directory || positionals.length !== 1) throw new Error(usage)
    const records = loadRecords(resolve(directory))
    const comparison = compareRecords(
      records,
      (values.require ?? '').split(',').filter((name) => name !== '')
    )
    if (values.output)
      writeFileSync(resolve(values.output), `${JSON.stringify(comparison, null, 2)}\n`)
    log(
      [renderMarkdown(comparison), ...explainDifferences(resolve(directory), comparison)].join('\n')
    )
    return comparison.ok ? 0 : 1
  }
  throw new Error(usage)
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
