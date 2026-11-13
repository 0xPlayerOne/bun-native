#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Duplicate dependency check (#259). A package resolved at more than one
 * version in a lockfile is either an accepted, recorded upstream split or a
 * new duplicate that should be unified. The accepted set lives in
 * `scripts/quality/duplicate-dependencies.json`, keyed by lockfile:
 *
 *   { "Cargo.lock": { "bitflags": ["1.3.2", "2.13.2"] }, "bun.lock": {} }
 *
 * The check fails on a duplicate that is not recorded, on a recorded duplicate
 * that gained a version, and on a recorded entry that is no longer duplicated
 * (so the record only ever shrinks with the real lockfile).
 *
 *   bun scripts/quality/duplicate-dependencies.ts [--write]
 *
 * `--write` rewrites the record from the lockfiles; review the diff.
 */

const LOCKFILES = ['Cargo.lock', 'bun.lock', 'experiments/native-allocation-api/Cargo.lock']
const RECORD = 'scripts/quality/duplicate-dependencies.json'

export type Duplicates = Record<string, string[]>

function duplicatesOf(versions: Map<string, Set<string>>): Duplicates {
  const out: Duplicates = {}
  for (const [name, set] of [...versions].sort(([a], [b]) => a.localeCompare(b)))
    if (set.size > 1) out[name] = [...set].sort()
  return out
}

function add(versions: Map<string, Set<string>>, name: string, version: string) {
  if (!versions.has(name)) versions.set(name, new Set())
  versions.get(name)!.add(version)
}

/** Packages with more than one resolved version in a Cargo.lock. */
export function cargoDuplicates(text: string): Duplicates {
  const versions = new Map<string, Set<string>>()
  for (const block of text.split(/^\[\[package\]\]$/m).slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1]
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1]
    if (!name || !version) throw new Error('Cargo.lock package entry lacks a name or version')
    add(versions, name, version)
  }
  return duplicatesOf(versions)
}

/** Packages with more than one resolved version in a text bun.lock. */
export function bunDuplicates(text: string): Duplicates {
  const lock = Bun.JSONC.parse(text) as { packages?: Record<string, unknown[]> }
  if (!lock.packages || typeof lock.packages !== 'object')
    throw new Error('bun.lock has no packages map')
  const versions = new Map<string, Set<string>>()
  for (const [key, entry] of Object.entries(lock.packages)) {
    const spec = Array.isArray(entry) ? entry[0] : undefined
    if (typeof spec !== 'string') throw new Error(`bun.lock entry ${key} lacks a resolution`)
    const at = spec.lastIndexOf('@')
    if (at <= 0) throw new Error(`bun.lock entry ${key} has resolution ${spec}`)
    const version = spec.slice(at + 1)
    // Workspace packages are sources in this checkout, not resolved versions.
    if (version.startsWith('workspace:')) continue
    add(versions, spec.slice(0, at), version)
  }
  return duplicatesOf(versions)
}

function lockDuplicates(path: string, text: string): Duplicates {
  return path.endsWith('Cargo.lock') ? cargoDuplicates(text) : bunDuplicates(text)
}

function hint(lockfile: string, name: string) {
  return lockfile.endsWith('Cargo.lock')
    ? `cargo tree --locked --manifest-path ${lockfile.replace(/Cargo\.lock$/, 'Cargo.toml')} -i ${name} --duplicates`
    : `bun pm why ${name}`
}

/** Differences between actual duplicates and the record, as actionable lines. */
export function compareDuplicates(
  actual: Record<string, Duplicates>,
  record: Record<string, Duplicates>
): string[] {
  const errors: string[] = []
  for (const lockfile of new Set([...Object.keys(actual), ...Object.keys(record)])) {
    const found = actual[lockfile] ?? {}
    const accepted = record[lockfile] ?? {}
    for (const [name, versions] of Object.entries(found)) {
      const known = accepted[name]
      if (!known)
        errors.push(
          `${lockfile}: new duplicate ${name} ${versions.join(', ')}; unify it or record it (see: ${hint(lockfile, name)})`
        )
      else if (versions.some((version) => !known.includes(version)))
        errors.push(
          `${lockfile}: ${name} gained a version: ${versions.join(', ')} (recorded ${known.join(', ')}; see: ${hint(lockfile, name)})`
        )
    }
    for (const [name, versions] of Object.entries(accepted)) {
      const now = found[name]
      if (!now)
        errors.push(`${lockfile}: ${name} is no longer duplicated; remove it from ${RECORD}`)
      else if (versions.some((version) => !now.includes(version)))
        errors.push(
          `${lockfile}: ${name} no longer resolves ${versions.filter((v) => !now.includes(v)).join(', ')}; update ${RECORD}`
        )
    }
  }
  return errors
}

function actualDuplicates(root: string): Record<string, Duplicates> {
  const out: Record<string, Duplicates> = {}
  for (const lockfile of LOCKFILES) {
    const path = join(root, lockfile)
    if (!existsSync(path)) throw new Error(`${lockfile} is missing`)
    out[lockfile] = lockDuplicates(lockfile, readFileSync(path, 'utf8'))
  }
  return out
}

export function checkDuplicates(root: string): string[] {
  const record = JSON.parse(readFileSync(join(root, RECORD), 'utf8')) as Record<string, Duplicates>
  return compareDuplicates(actualDuplicates(root), record)
}

export function main(args: string[], root = resolve(import.meta.dir, '../..')): number {
  if (args.includes('--write')) {
    const actual = actualDuplicates(root)
    writeFileSync(join(root, RECORD), JSON.stringify(actual, null, 2) + '\n')
    console.log(`Recorded duplicates in ${RECORD}; review the diff`)
    return 0
  }
  const errors = checkDuplicates(root)
  if (errors.length) {
    console.error(errors.join('\n'))
    return 1
  }
  const counts = Object.entries(actualDuplicates(root)).map(
    ([lockfile, duplicates]) => `${lockfile} ${Object.keys(duplicates).length}`
  )
  console.log(`Duplicate dependencies match the record (${counts.join(', ')})`)
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
