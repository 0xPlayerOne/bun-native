import { chmod, copyFile, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import toolchain from '../toolchain.json'
import { checkBoundaries } from './quality/boundaries.ts'
import { checkSourceHealth } from './quality/source-health.ts'
import { verifyPackageArchive } from './native/package-archive.ts'
import {
  cliSourceClosure,
  consumerDefinitions,
  librarySourceFiles,
  materializedManifests,
} from './native/package-source.ts'
import {
  packageNames,
  parsePackageSet,
  type LocalPackage,
  type PackageSet,
} from './native/package-set.ts'
import { fileDigest, type FileDigest } from './native/artifact.ts'
import { inside, packagePath } from './native/paths.ts'

const repository = resolve(import.meta.dir, '..')

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', repository, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdout.toString()
}

async function snapshot(): Promise<PackageSet['source']> {
  if (git('status', '--porcelain', '--untracked-files=all') !== '')
    throw new Error('Package production requires a clean committed source tree')
  const files: Record<string, FileDigest> = {}
  for (const path of git('ls-files', '-z').split('\0').filter(Boolean).sort()) {
    if (!packagePath(path) || !(await lstat(join(repository, path))).isFile())
      throw new Error(`Source inventory requires portable regular files: ${path}`)
    files[path] = await fileDigest(join(repository, path))
  }
  return {
    commit: git('rev-parse', 'HEAD').trim(),
    tree: git('rev-parse', 'HEAD^{tree}').trim(),
    files,
  }
}

async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, strict: true, options: { outdir: { type: 'string' } } })
  if (!values.outdir || !isAbsolute(values.outdir))
    throw new Error(
      'Usage: bun scripts/package-native.ts --outdir /new/absolute/package-set-directory'
    )
  if (Bun.revision !== toolchain.bun.revision)
    throw new Error('Use the pinned Bun package producer')
  const source = await snapshot()
  const compiler = {
    revision: Bun.revision,
    os: process.platform,
    architecture: process.arch,
    executable: await fileDigest(process.execPath),
  }
  const errors = [...(await checkBoundaries(repository)), ...(await checkSourceHealth(repository))]
  if (errors.length) throw new Error(errors.join('\n'))
  const cli = await cliSourceClosure(repository)
  const manifests = await materializedManifests(repository, cli.external)
  const consumers = await consumerDefinitions(repository, manifests)
  const output = resolve(values.outdir)
  await mkdir(dirname(output), { recursive: true })
  const parent = await realpath(dirname(output))
  if (parent === repository || inside(repository, parent))
    throw new Error('Produce the package set outside the source checkout')
  await mkdir(output) // Existing directories are never adopted or overwritten.
  try {
    const packages: Record<string, LocalPackage> = {}
    await mkdir(join(output, 'archives'))
    await mkdir(join(output, 'logs'))
    for (const name of packageNames) {
      const isCli = name === '@bun-native/cli'
      const short = name.slice('@bun-native/'.length)
      const directory = join(output, isCli ? 'cli' : `staging/${short}`)
      await mkdir(directory, { recursive: true })
      const originals = isCli
        ? cli.files.map((path) => ({ original: path, target: `src/${path}` }))
        : (await librarySourceFiles(join(repository, 'packages', short))).map((path) => ({
            original: `packages/${short}/${path}`,
            target: path,
          }))
      originals.push({ original: 'LICENSE', target: 'LICENSE' })
      const sourceFiles: Record<string, FileDigest> = {}
      sourceFiles['package.json'] = source.files['package.json']!
      if (!isCli)
        sourceFiles[`packages/${short}/package.json`] =
          source.files[`packages/${short}/package.json`]!
      for (const { original, target } of originals) {
        if (!source.files[original]) throw new Error(`Untracked package input: ${original}`)
        await mkdir(dirname(join(directory, target)), { recursive: true })
        await copyFile(join(repository, original), join(directory, target))
        if (!isDeepStrictEqual(await fileDigest(join(directory, target)), source.files[original]))
          throw new Error(`Source changed while staging: ${original}`)
        sourceFiles[original] = source.files[original]!
      }
      const generated: Record<string, string> = {
        'package.json': JSON.stringify(manifests[name], null, 2) + '\n',
        'bun-native-source.json':
          JSON.stringify(
            {
              schemaVersion: 1,
              commit: source.commit,
              tree: source.tree,
              files: sourceFiles,
              toolchain: source.files['toolchain.json'],
              dependencyLock: source.files['bun.lock'],
            },
            null,
            2
          ) + '\n',
        'README.md': `# ${name}\n\nPrivate experimental Bun Native source package from [${source.commit}](https://github.com/0xPlayerOne/bun-native/tree/${source.commit}). Install through its local package-set manifest and pinned consumer lock. Use Bun revision ${toolchain.bun.revision}; supply the compatible native host explicitly. No registry release or platform signing is implied. Original license notice is retained in LICENSE.\n`,
      }
      for (const [path, text] of Object.entries(generated))
        await writeFile(join(directory, path), text, { flag: 'wx' })
      if (isCli) await chmod(join(directory, 'src/scripts/native.ts'), 0o755)
      const files: Record<string, FileDigest> = {}
      for (const path of [
        ...originals.map(({ target }) => target),
        ...Object.keys(generated),
      ].sort())
        files[path] = await fileDigest(join(directory, path))
      const archive = `archives/bun-native-${short}-${manifests[name]!.version}-${source.commit.slice(0, 12)}.tgz`
      const command = [
        process.execPath,
        '--no-install',
        'pm',
        'pack',
        '--ignore-scripts',
        '--filename',
        join(output, archive),
      ]
      const result = Bun.spawnSync(command, {
        cwd: directory,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      })
      await writeFile(join(output, 'logs', `${short}.stdout.log`), result.stdout, { flag: 'wx' })
      await writeFile(join(output, 'logs', `${short}.stderr.log`), result.stderr, { flag: 'wx' })
      await writeFile(
        join(output, 'logs', `${short}.json`),
        JSON.stringify(
          { command, cwd: directory, exitCode: result.exitCode, signal: result.signalCode ?? null },
          null,
          2
        ) + '\n',
        { flag: 'wx' }
      )
      if (result.exitCode !== 0 || result.signalCode)
        throw new Error(`Package ${name} failed (${result.exitCode}): ${result.stderr}`)
      await verifyPackageArchive(join(output, archive), files)
      packages[name] = {
        manifest: manifests[name]!,
        files,
        archive: { file: archive, ...(await fileDigest(join(output, archive))) },
      }
    }
    if (
      !isDeepStrictEqual(source, await snapshot()) ||
      !isDeepStrictEqual(compiler.executable, await fileDigest(process.execPath))
    )
      throw new Error('Package source or compiler changed during production')
    const manifest = parsePackageSet({
      schemaVersion: 1,
      source,
      toolchain,
      compiler,
      packages,
      consumers,
    })
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
    })
    console.log(`Created source-bound local package set: ${join(output, 'manifest.json')}`)
    console.log(
      `Bootstrap: bun --no-install ${join(output, 'cli/src/scripts/native.ts')} create PROJECT --packages ${join(output, 'manifest.json')}`
    )
  } catch (error) {
    // Keep raw pack logs/partial outputs for diagnosis, never a success manifest.
    await writeFile(
      join(output, 'failure.json'),
      JSON.stringify({ status: 'failed', error: String(error), source }, null, 2) + '\n',
      { flag: 'wx' }
    )
    throw error
  } finally {
    await rm(join(output, 'staging'), { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
