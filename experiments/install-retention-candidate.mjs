// One exact official research compiler. Does not modify toolchain.json or PATH.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { downloadPinnedArchive } from '../scripts/install-bun/download.mjs'
import { extractPinnedExecutable } from '../scripts/install-bun/archive.mjs'

const directory = process.argv[2]
if (
  typeof directory !== 'string' ||
  !isAbsolute(directory) ||
  process.platform !== 'win32' ||
  process.arch !== 'x64'
)
  throw new Error('The fixed candidate requires an owned Windows x64 research directory')
const receipt = JSON.parse(
  readFileSync(new URL('./retention-evidence/windows-candidate-pin.json', import.meta.url), 'utf8')
)
const archive = await downloadPinnedArchive(receipt.pin)
const binary = extractPinnedExecutable(archive, receipt.pin, 'win32-x64')
const archiveSha256 = createHash('sha256').update(archive).digest('hex')
const binarySha256 = createHash('sha256').update(binary).digest('hex')
if (
  archiveSha256 !== receipt.archiveSha256 ||
  binarySha256 !== receipt.binarySha256 ||
  binary.length !== receipt.binaryBytes
)
  throw new Error('Candidate distribution bytes do not match the reviewed package')
mkdirSync(directory, { recursive: true })
const executable = join(directory, 'bun.exe')
writeFileSync(executable, binary, { flag: 'wx' })
const result = spawnSync(
  executable,
  ['-e', 'console.log(JSON.stringify({version:Bun.version,revision:Bun.revision}))'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 }
)
if (result.error || result.status !== 0) throw new Error('Candidate identity execution failed')
const identity = JSON.parse(result.stdout)
if (identity.revision !== receipt.revision)
  throw new Error('Candidate full revision does not match its official source')
writeFileSync(
  join(directory, 'receipt.json'),
  JSON.stringify({ ...receipt, executable, executed: true, identity }, null, 2) + '\n',
  { flag: 'wx' }
)
console.log(JSON.stringify({ executable, identity, archiveSha256, binarySha256 }))
