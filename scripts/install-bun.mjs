import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { downloadPinnedArchive, validatePackagePin } from './install-bun/download.mjs'
import { extractPinnedExecutable } from './install-bun/archive.mjs'
import { createHash } from 'node:crypto'

// Node bootstraps Bun so a clean hosted runner does not need another Bun version.
const manifest = JSON.parse(readFileSync(new URL('../toolchain.json', import.meta.url), 'utf8'))
// Public npm archives need no credential. Never inherit a formerly scoped token.
delete process.env.BUN_NATIVE_GITHUB_TOKEN
if (manifest.schemaVersion !== 2 || manifest.bun.distribution !== 'npm')
  throw new Error('Expected the explicit npm Bun distribution manifest')
const args = process.argv.slice(2)
const destination = args[1]
if (
  args.length !== 2 ||
  args[0] !== '--destination' ||
  typeof destination !== 'string' ||
  !isAbsolute(destination)
) {
  throw new Error('Usage: node scripts/install-bun.mjs --destination <absolute directory>')
}
const target = `${process.platform}-${process.arch}`
const archive = manifest.bun.packages[target]
if (!archive) throw new Error(`No pinned Bun package for ${target}`)
validatePackagePin(archive)
if (!archive.version.endsWith(`+${manifest.bun.revision.slice(0, 7)}`))
  throw new Error('Pinned package version does not match the Bun source revision')
const executableName = process.platform === 'win32' ? 'bun.exe' : 'bun'
const executable = join(destination, executableName)

/** @param {string} path */
function verifyRevision(path) {
  const result = spawnSync(path, ['--revision'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16_384,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Bun revision check failed: ${result.error?.message ?? result.stderr}`)
  }
  const actual = result.stdout.trim()
  if (actual !== manifest.bun.cliRevision) {
    throw new Error(`Bun revision mismatch: expected ${manifest.bun.cliRevision}, got ${actual}`)
  }
}

const reusedExisting = existsSync(executable)
if (reusedExisting) {
  verifyRevision(executable)
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'bun-native-install-'))
  try {
    const bytes = await downloadPinnedArchive(archive)
    const binary = extractPinnedExecutable(bytes, archive, target)
    const candidate = join(temporary, executableName)
    writeFileSync(candidate, binary, { flag: 'wx', mode: 0o755 })
    if (process.platform !== 'win32') chmodSync(candidate, 0o755)
    verifyRevision(candidate)
    mkdirSync(destination, { recursive: true })
    try {
      // Exclusive like COPYFILE_EXCL, but avoids rewriting ~130 MB when both
      // directories share a filesystem. Removing the temporary name keeps this one.
      linkSync(candidate, executable)
    } catch {
      copyFileSync(candidate, executable, constants.COPYFILE_EXCL)
    }
    if (process.platform !== 'win32') chmodSync(executable, 0o755)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

const bunx = join(destination, process.platform === 'win32' ? 'bunx.exe' : 'bunx')
if (existsSync(bunx)) {
  const binaryStat = statSync(executable)
  const aliasStat = statSync(bunx)
  if (aliasStat.dev !== binaryStat.dev || aliasStat.ino !== binaryStat.ino) {
    throw new Error(`Existing bunx does not refer to the pinned Bun executable: ${bunx}`)
  }
} else {
  linkSync(executable, bunx)
}

if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${destination}\n`)
console.log(
  JSON.stringify({
    executable,
    revision: manifest.bun.cliRevision,
    reusedExisting,
    package: archive.name,
    packageVersion: archive.version,
    downloadedIntegrity: reusedExisting ? null : archive.integrity,
    executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  })
)
