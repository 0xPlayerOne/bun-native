/** Native-workspace routing for the pinned Foundry gate; never skips another language's checks. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
export interface GateCommand {
  readonly command: readonly string[]
  readonly cwd: string
}
const root = resolve(import.meta.dir, '..')
export function nativeManifests(files: readonly string[]): string[] {
  const manifests = new Set<string>()
  for (const file of files) {
    if (file === 'rust-toolchain.toml') manifests.add('native/Cargo.toml')
    if (file === '.cargo/config.toml') {
      manifests.add('native/Cargo.toml')
      manifests.add('native/cef-host/Cargo.toml')
    }
    if (!/\.rs$|(?:^|\/)Cargo\.(?:toml|lock)$/.test(file)) continue
    if (file.startsWith('native/cef-host/')) manifests.add('native/cef-host/Cargo.toml')
    else if (file.startsWith('native/')) manifests.add('native/Cargo.toml')
    else throw new Error('Native source has no declared workspace: ' + file)
  }
  return [...manifests].sort()
}
export function nativeCommands(files: readonly string[], directory: string): GateCommand[] {
  return nativeManifests(files).flatMap((manifest) => [
    {
      command: [
        'cargo',
        manifest.includes('cef-host') ? '+1.91.0' : '+1.85.1',
        'fmt',
        '--manifest-path',
        manifest,
        '--check',
      ],
      cwd: directory,
    },
    {
      command: [
        'cargo',
        manifest.includes('cef-host') ? '+1.91.0' : '+1.85.1',
        'clippy',
        '--locked',
        '--manifest-path',
        manifest,
        '--all-targets',
        ...(manifest.includes('cef-host') ? ['--features', 'packaging'] : []),
        '--',
        '-D',
        'warnings',
      ],
      cwd: directory,
    },
  ])
}
interface FoundryPlan {
  formatAll: boolean
  formatFiles: string[]
  lintAll: boolean
  lintFiles: string[]
  typeCheck: boolean
  pythonAll: boolean
  pythonFiles: string[]
  rust: boolean
  build: boolean
}
async function execute(args: readonly string[], cwd = root) {
  console.log('+ ' + args.join(' '))
  const child = Bun.spawn([...args], {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`Commit gate failed (${code}): ${args[0]}`)
}
async function staged() {
  const p = Bun.spawn(['git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(p.stdout).text()
  if (await p.exited) throw new Error('Cannot inspect staged source')
  return out.split('\0').filter(Boolean)
}
export async function runNativeGate(files: readonly string[]): Promise<void> {
  if (!nativeManifests(files).length)
    throw new Error('Native gate was called without native changes; use the normal Foundry gate')
  await execute(['git', 'diff', '--cached', '--check'])
  // Retain the same format/lint/type/Python planning implementation as the installed release.
  const provider = (await import(
    pathToFileURL(resolve(root, 'node_modules/code-foundry/src/lib/pre-commit.mjs')).href
  )) as {
    planPreCommit(
      files: readonly string[],
      options: { checkJs: boolean; build: boolean }
    ): FoundryPlan
    chunkFiles(files: readonly string[]): string[][]
  }
  const config = await Bun.file(resolve(root, '.github/code-foundry.yml')).text()
  const plan = provider.planPreCommit(files, {
    checkJs: existsSync(resolve(root, 'jsconfig.json')),
    build: /^pre_commit_build:\s*true\s*$/m.test(config),
  })
  if (plan.formatAll) await execute([process.execPath, 'fmt', '--no-script', '--check', '.'])
  else
    for (const chunk of provider.chunkFiles(plan.formatFiles))
      await execute([process.execPath, 'fmt', '--no-script', '--check', ...chunk])
  if (plan.build) await execute([process.execPath, 'run', 'build'])
  if (plan.lintAll) await execute([process.execPath, 'run', 'lint'])
  else
    for (const chunk of provider.chunkFiles(plan.lintFiles))
      await execute([
        process.execPath,
        '--bun',
        'oxlint',
        '--deny-warnings',
        '--no-error-on-unmatched-pattern',
        ...chunk,
      ])
  if (plan.typeCheck) await execute([process.execPath, 'run', 'typecheck'])
  for (const item of nativeCommands(files, root)) await execute(item.command, item.cwd)
  if (plan.pythonAll) {
    await execute(['ruff', 'format', '--check', '.'])
    await execute(['ruff', 'check', '.'])
  } else
    for (const chunk of provider.chunkFiles(plan.pythonFiles)) {
      await execute(['ruff', 'format', '--check', '--force-exclude', ...chunk])
      await execute(['ruff', 'check', '--force-exclude', ...chunk])
    }
}
export const nativeHookInvocation = `if bun scripts/native-pre-commit.ts --detect; then
    exec bun scripts/native-pre-commit.ts
  else
    native_status=$?
    [ "$native_status" -eq 3 ] || exit "$native_status"
  fi
  exec bun --bun code-foundry pre-commit`
if (import.meta.main) {
  try {
    const files = await staged()
    if (process.argv[2] === '--detect') process.exit(nativeManifests(files).length ? 0 : 3)
    if (process.argv.length !== 2) throw new Error('Unsupported native gate arguments')
    await runNativeGate(files)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Native commit gate failed')
    process.exitCode = 1
  }
}
