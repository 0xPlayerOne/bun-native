import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function regularFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile()) throw new Error(`Expected a regular generated file: ${entry.name}`)
      return entry.name
    })
    .sort()
}

export function fingerprint(path: string) {
  const bytes = readFileSync(path)
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Run only after the real template's ready IPC record, while its CLI child is live. */
export function captureDevelopmentModule(project: string, retainedModule: string) {
  const bundles = join(project, '.bun-native')
  const entries = readdirSync(bundles, { withFileTypes: true })
  const entry = entries[0]
  if (entries.length !== 1 || !entry?.isDirectory() || !entry.name.startsWith('dev-'))
    throw new Error('native dev must own one temporary module at readiness')
  const directory = join(bundles, entry.name)
  const names = regularFiles(directory)
  if (!names.includes('application.js')) throw new Error('native dev module is missing')
  mkdirSync(retainedModule)
  const artifacts = names.map((name) => {
    const path = join(directory, name)
    const before = fingerprint(path)
    const retained = join(retainedModule, name)
    copyFileSync(path, retained, constants.COPYFILE_EXCL)
    if (fingerprint(retained).sha256 !== before.sha256)
      throw new Error('Retained dev module differs from the running module')
    return { ...before, retained }
  })
  return { directory, artifacts }
}

/** Inspect only after observeTemplate has joined the app and drained its IPC. */
export function developmentModuleCleanup(
  project: string,
  module: ReturnType<typeof captureDevelopmentModule> | undefined
) {
  const bundles = join(project, '.bun-native')
  const remaining = existsSync(bundles) ? readdirSync(bundles).sort() : []
  return {
    remaining,
    removed: module !== undefined && !existsSync(module.directory) && remaining.length === 0,
  }
}
