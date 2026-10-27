/** Bounded fixture frontend adapter. Source bytes, not notification counters, define the update. */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export interface ManagedFrontendSource {
  readonly version: 0 | 1 | 2
  readonly frontend: 0 | 1
  readonly shared: 0 | 1
  readonly css: string
  readonly sha256: string
}

async function source(path: string): Promise<string> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 4096)
    throw new Error('HMR_SOURCE_INVALID')
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (
    bytes.length !== before.size ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.size !== before.size ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs
  )
    throw new Error('HMR_SOURCE_CHANGED_DURING_READ')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export async function readManagedFrontendSource(
  projectRoot: string
): Promise<ManagedFrontendSource> {
  if (!isAbsolute(projectRoot)) throw new Error('HMR_SOURCE_INVALID')
  const [stylesheet, sharedModule] = await Promise.all([
    source(join(projectRoot, 'frontend/style.css')),
    source(join(projectRoot, 'shared/value.ts')),
  ])
  // This is a fixed qualification adapter, not a parser or evaluator for user JS.
  const style = /^\s*:root\s*\{\s*--fixture-revision\s*:\s*([01])\s*;?\s*\}\s*$/.exec(stylesheet)
  const module = /^\s*export\s+const\s+shared\s*=\s*([01])\s*;?\s*$/.exec(sharedModule)
  if (!style || !module) throw new Error('HMR_SOURCE_INVALID')
  const frontend = Number(style[1]) as 0 | 1
  const shared = Number(module[1]) as 0 | 1
  if (shared > frontend) throw new Error('HMR_SOURCE_ORDER')
  const css = stylesheet + `\n:root { --managed-shared: ${shared}; }\n`
  return Object.freeze({
    version: (frontend + shared) as 0 | 1 | 2,
    frontend,
    shared,
    css,
    sha256: createHash('sha256').update(css).digest('hex'),
  })
}
