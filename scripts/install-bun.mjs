import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
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
import { downloadPinnedArchive } from './install-bun/download.mjs'

// Node bootstraps Bun so a clean hosted runner does not need another Bun version.
const manifest = JSON.parse(readFileSync(new URL('../toolchain.json', import.meta.url), 'utf8'))
// The optional Actions credential belongs only to the immutable asset request.
// Unzip/PowerShell and even a verified Bun subprocess must not inherit it.
const downloadToken = process.env.BUN_NATIVE_GITHUB_TOKEN
delete process.env.BUN_NATIVE_GITHUB_TOKEN
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--destination' || !isAbsolute(args[1])) {
  throw new Error('Usage: node scripts/install-bun.mjs --destination <absolute directory>')
}
const destination = args[1]
const target = `${process.platform}-${process.arch}`
const archive = manifest.bun.archives[target]
if (!archive) throw new Error(`No pinned Bun archive for ${target}`)
const executableName = process.platform === 'win32' ? 'bun.exe' : 'bun'
const executable = join(destination, executableName)

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`)
  }
  return result.stdout.trim()
}

function verifyRevision(path) {
  const actual = run(path, ['--revision'])
  if (actual !== manifest.bun.cliRevision) {
    throw new Error(`Bun revision mismatch: expected ${manifest.bun.cliRevision}, got ${actual}`)
  }
}

if (existsSync(executable)) {
  verifyRevision(executable)
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'bun-native-install-'))
  try {
    // Asset IDs are immutable. An expired/deleted canary asset fails closed;
    // never fall back to the mutable `canary` download URL or another version.
    const bytes = await downloadPinnedArchive(archive, { token: downloadToken })
    const archivePath = join(temporary, archive.name)
    const extracted = join(temporary, 'extracted')
    writeFileSync(archivePath, bytes)
    mkdirSync(extracted)
    if (process.platform === 'win32') {
      run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $env:BUN_NATIVE_ARCHIVE -DestinationPath $env:BUN_NATIVE_EXTRACT',
        ],
        {
          env: {
            ...process.env,
            BUN_NATIVE_ARCHIVE: archivePath,
            BUN_NATIVE_EXTRACT: extracted,
          },
        }
      )
    } else {
      run('unzip', ['-q', archivePath, '-d', extracted])
    }
    const candidate = join(extracted, archive.name.replace(/\.zip$/, ''), executableName)
    if (process.platform !== 'win32') chmodSync(candidate, 0o755)
    verifyRevision(candidate)
    mkdirSync(destination, { recursive: true })
    copyFileSync(candidate, executable)
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
  JSON.stringify({ executable, revision: manifest.bun.cliRevision, archiveSha256: archive.sha256 })
)
