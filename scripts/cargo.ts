/** Run local Cargo commands with a target directory shared by Bunly worktrees. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { cargoEnvironment, cefManifestPath } from './cargo-config.ts'
import { cargoTargetDirectory } from './cargo-artifacts.ts'

const args = process.argv.slice(2)
if (!args.length) throw new Error('Usage: bun scripts/cargo.ts [cargo arguments]')

if (args[0] === '--print-target-dir') {
  const options = args.slice(1)
  const manifest =
    options.length === 0
      ? join(import.meta.dir, '../native/Cargo.toml')
      : options.length === 2 && options[0] === '--manifest-path'
        ? options[1]!
        : options.length === 1 && options[0]!.startsWith('--manifest-path=')
          ? options[0]!.slice('--manifest-path='.length)
          : undefined
  if (!manifest) throw new Error('Usage: --print-target-dir [--manifest-path Cargo.toml]')
  console.log(cargoTargetDirectory(manifest))
  process.exit(0)
}

const manifest = cefManifestPath(args)
const cefVersion =
  manifest && !process.env.CEF_PATH
    ? await lockedCefVersion(join(dirname(resolve(manifest)), 'Cargo.lock'))
    : undefined
const { targetDir, env } = cargoEnvironment(
  args,
  process.env,
  process.platform,
  undefined,
  cefVersion
)
if (targetDir !== undefined) await mkdir(resolve(targetDir), { recursive: true, mode: 0o700 })

const child = Bun.spawn(['cargo', ...args], {
  env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(await child.exited)

async function lockedCefVersion(lockPath: string) {
  const lockfile = await readFile(lockPath, 'utf8')
  const cefPackage = lockfile.split('[[package]]').find((entry) => /^name = "cef"$/m.test(entry))
  const version = cefPackage?.match(/^version = "([^"]+)"$/m)?.[1]
  if (!version) throw new Error(`Could not read the locked CEF version from ${lockPath}`)
  return version
}
