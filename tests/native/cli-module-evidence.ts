import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

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
  let pending: string | undefined
  try {
    pending = mkdtempSync(join(dirname(retainedModule), '.native-module-evidence-'))
    const staged = pending
    const artifacts = names.map((name) => {
      const path = join(directory, name)
      const before = fingerprint(path)
      const temporary = join(staged, name)
      copyFileSync(path, temporary, constants.COPYFILE_EXCL)
      if (fingerprint(temporary).sha256 !== before.sha256)
        throw new Error('Retained dev module differs from the running module')
      return { ...before, retained: join(retainedModule, name) }
    })
    // Entry existence lets the headless consumer close its CLI and remove the
    // source module. Publish it only after every source byte has been captured
    // and verified; a partial copy must never authorize that cleanup.
    for (const name of names.filter((name) => name !== 'application.js'))
      renameSync(join(staged, name), join(retainedModule, name))
    renameSync(join(staged, 'application.js'), join(retainedModule, 'application.js'))
    return { directory, artifacts }
  } catch (error) {
    // mkdirSync above exclusively reserved this previously absent directory.
    rmSync(retainedModule, { recursive: true, force: true })
    throw error
  } finally {
    if (pending) rmSync(pending, { recursive: true, force: true })
  }
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
