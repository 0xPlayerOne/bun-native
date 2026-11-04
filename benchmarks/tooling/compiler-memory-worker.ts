import { createHash } from 'node:crypto'
import { createReadStream, existsSync, writeSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import toolchain from '../../toolchain.json'

const repository = resolve(import.meta.dir, '../..')
const [framework, countText, nonce, temporaryRoot] = process.argv.slice(2)
if (
  process.argv.length !== 6 ||
  (framework !== 'solid' && framework !== 'react') ||
  (countText !== '101' && countText !== '1001') ||
  !nonce ||
  !/^[a-f0-9]{32}$/.test(nonce) ||
  !temporaryRoot ||
  !basename(temporaryRoot).startsWith(`bun-native-compiler-memory-${nonce}-`) ||
  (await realpath(temporaryRoot)) !== resolve(temporaryRoot) ||
  (await realpath(dirname(temporaryRoot))) !== (await realpath(tmpdir())) ||
  Bun.revision !== toolchain.bun.revision
)
  throw new Error('Use the pinned compiler through benchmarks/tooling/compiler-memory.py')

const count = Number(countText)
const name = `${framework}-${count}`
const projectDirectory = join(repository, '.bun-native', `compiler-memory-${nonce}`, name)
const bundleDirectory = join(temporaryRoot, name)
const started = performance.now()
let attempted = 0
let successful = 0

function emit(stage: string, values: Record<string, unknown> = {}): void {
  const memory = process.memoryUsage()
  writeSync(
    1,
    JSON.stringify({
      stage,
      framework,
      count,
      nonce,
      pid: process.pid,
      elapsedMs: performance.now() - started,
      memory,
      ...values,
    }) + '\n'
  )
}

async function artifact(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    hash.update(chunk)
  }
  return { bytes, sha256: hash.digest('hex') }
}

/** Bounded streaming check: exactly two current labels and no stale label. */
async function inspectModule(path: string, token: string) {
  const prefix = Buffer.from('__bn_compiler_memory_')
  const hash = createHash('sha256')
  let bytes = 0
  let occurrences = 0
  let carry: Buffer<ArrayBuffer> = Buffer.alloc(0)
  const inspect = (buffer: Buffer, end: number) => {
    let offset = buffer.indexOf(prefix)
    while (offset >= 0 && offset < end) {
      if (buffer.subarray(offset, offset + token.length).toString() !== token)
        throw new Error('Emitted module contains a stale or incomplete source label')
      occurrences++
      offset = buffer.indexOf(prefix, offset + prefix.length)
    }
  }
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    hash.update(chunk)
    const buffer = Buffer.concat([carry, chunk])
    const end = Math.max(0, buffer.length - token.length + 1)
    inspect(buffer, end)
    // Copy the small tail, without retaining the preceding chunk's backing store.
    carry = Buffer.from(buffer.subarray(end))
  }
  inspect(carry, carry.length)
  if (occurrences !== 2) throw new Error(`Expected two source labels, received ${occurrences}`)
  return { bytes, sha256: hash.digest('hex'), occurrences }
}

emit('start', {
  revision: Bun.revision,
  executable: process.execPath,
  mode: 'bundling only; emitted module never executed',
})
let status: 'passed' | 'failed' = 'failed'
let error: string | undefined
let projectOwned = false
let bundlesOwned = false
try {
  // This is the same public bundling path used by the CLI. Its Solid branch
  // applies the existing Babel universal transform; React uses Bun's JSX path.
  const { bundleProject } = await import('../../scripts/native/build.ts')
  const { createProject, readProject } = await import('../../scripts/native/project.ts')
  await mkdir(bundleDirectory)
  bundlesOwned = true
  await createProject(repository, projectDirectory, framework, 'typescript')
  projectOwned = true
  const project = await readProject(repository, projectDirectory)
  const original = await readFile(project.entry, 'utf8')
  const title = `Bun Native ${framework === 'solid' ? 'Solid' : 'React'}`
  if (original.split(title).length !== 3) throw new Error('Template does not have two title sites')
  emit('initialized', { projectDirectory, bundleDirectory })
  let previous: string | undefined
  for (let index = 0; index < count; index++) {
    const token = `__bn_compiler_memory_${framework}_${count}_${nonce}_${String(index).padStart(4, '0')}__`
    const source = original.replaceAll(title, token)
    await writeFile(project.entry, source)
    const candidate = join(bundleDirectory, `generation-${String(index).padStart(4, '0')}`)
    await mkdir(candidate)
    attempted++
    const before = performance.now()
    const entry = await bundleProject(project, candidate)
    const bundled = performance.now()
    if (entry !== join(candidate, 'application.js')) throw new Error('Unexpected module path')
    const module = await inspectModule(entry, token)
    const map = await artifact(entry + '.map')
    if ((await readdir(candidate)).sort().join(',') !== 'application.js,application.js.map')
      throw new Error('Unexpected compiler output files')
    if (previous) await rm(previous, { recursive: true })
    previous = candidate
    const live = await readdir(bundleDirectory)
    if (live.length !== 1 || live[0] !== basename(candidate))
      throw new Error('Prior compiler output generation remains present')
    successful++
    emit('build', {
      index,
      token,
      attempted,
      successful,
      bundleMs: bundled - before,
      validationAndCleanupMs: performance.now() - bundled,
      source: {
        bytes: Buffer.byteLength(source),
        sha256: createHash('sha256').update(source).digest('hex'),
      },
      module,
      sourcemap: map,
      liveGenerationDirectories: live.length,
    })
  }
  status = 'passed'
} catch (failure) {
  error = failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)
  emit('failure', { attempted, successful, error })
} finally {
  const cleanupErrors: string[] = []
  for (const path of [
    bundlesOwned ? bundleDirectory : undefined,
    projectOwned ? projectDirectory : undefined,
  ]) {
    if (path === undefined) continue
    try {
      await rm(path, { recursive: true, force: true })
    } catch (failure) {
      cleanupErrors.push(String(failure))
    }
  }
  const projectRemoved = projectOwned && !existsSync(projectDirectory)
  const bundlesRemoved = bundlesOwned && !existsSync(bundleDirectory)
  if (cleanupErrors.length || !projectRemoved || !bundlesRemoved || successful !== count)
    status = 'failed'
  emit('final', {
    status,
    attempted,
    successful,
    projectRemoved,
    bundlesRemoved,
    cleanupErrors,
    error,
  })
  if (status !== 'passed') process.exitCode = 1
}
