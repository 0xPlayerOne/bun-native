import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { consumerArchiveLock, parsePackageSet } from '../native/package-set.ts'
import { seedConsumerLock, verifyConsumerLock } from '../native/package-lock.ts'
import { fileDigest, type FileDigest } from '../native/artifact.ts'
import { inside } from '../native/paths.ts'
import toolchain from '../../toolchain.json'

const repository = resolve(import.meta.dir, '../..')
const measuredSource = {
  commit: 'c90804933034ccc942467de8eb47379d8ee47e71',
  tree: '4e944901d40ee3761d163cfc157e75d8f786469b',
}
const compiler = {
  bytes: 138_468_432,
  sha256: 'fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810',
}

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', repository, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  ensure(result.exitCode === 0, `git ${args[0]} failed: ${result.stderr}`)
  return result.stdout.toString()
}

async function sourceSnapshot() {
  ensure(git('status', '--porcelain', '--untracked-files=all') === '', 'Source must be clean')
  const files: Record<string, FileDigest> = {}
  for (const name of git('ls-files', '-z').split('\0').filter(Boolean).sort())
    files[name] = await fileDigest(join(repository, name))
  return {
    commit: git('rev-parse', 'HEAD').trim(),
    tree: git('rev-parse', 'HEAD^{tree}').trim(),
    files,
  }
}

async function inventory(directory: string) {
  const files: Record<string, FileDigest | 'directory'> = {}
  const visit = async (root: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isDirectory()) {
        files[name] = 'directory'
        await visit(join(root, entry.name), name + '/')
      } else {
        ensure(entry.isFile(), `Unexpected nonregular control entry: ${name}`)
        files[name] = await fileDigest(join(root, entry.name))
      }
    }
  }
  await visit(directory, '')
  return files
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      input: { type: 'string' },
      outdir: { type: 'string' },
    },
  })
  ensure(
    values.input && values.outdir && isAbsolute(values.input) && isAbsolute(values.outdir),
    'Usage: standalone-lock-control.ts --input ABSOLUTE_RETAINED_COHORT --outdir ABSOLUTE_NEW_DIRECTORY'
  )
  ensure(
    process.platform === 'linux' &&
      process.arch === 'x64' &&
      Bun.revision === toolchain.bun.revision,
    'Use the fixed Linux x64 pinned compiler'
  )
  ensure(isDeepStrictEqual(await fileDigest(process.execPath), compiler), 'Compiler bytes differ')
  const source = await sourceSnapshot()
  const input = await realpath(values.input)
  const output = join(await realpath(dirname(values.outdir)), values.outdir.split('/').at(-1)!)
  ensure(output !== input && !inside(input, output), 'Do not write into the retained cohort')
  for (const line of git('worktree', 'list', '--porcelain').split('\n'))
    if (line.startsWith('worktree ')) {
      const root = await realpath(line.slice('worktree '.length))
      ensure(
        output !== root && !inside(root, output),
        'Stage parser controls outside every checkout'
      )
    }
  const originalResult = await Bun.file(join(input, 'result.json')).json()
  const manifestPath = join(input, 'packages/manifest.json')
  const set = parsePackageSet(await Bun.file(manifestPath).json())
  ensure(
    isDeepStrictEqual(originalResult.source, measuredSource) &&
      set.source.commit === measuredSource.commit &&
      set.source.tree === measuredSource.tree,
    'Input is not the retained first cohort'
  )
  ensure(
    isDeepStrictEqual(await fileDigest(manifestPath), originalResult.package_set.manifest),
    'Retained package-set bytes differ'
  )
  await mkdir(output) // An existing result directory is never adopted.
  const inputs: Record<string, FileDigest> = {
    'result.json': await fileDigest(join(input, 'result.json')),
    'packages/manifest.json': await fileDigest(manifestPath),
  }
  const controls = [
    { name: 'original-solid', framework: 'solid' as const, corrected: false },
    { name: 'original-react', framework: 'react' as const, corrected: false },
    { name: 'corrected-solid', framework: 'solid' as const, corrected: true },
    { name: 'corrected-react', framework: 'react' as const, corrected: true },
  ].map((entry) => ({ ...entry, status: 'not-run' as string }))
  const report: Record<string, unknown> = {
    status: 'running',
    source,
    inputSource: measuredSource,
    compiler,
    inputs,
    controls,
    scope: 'Four read-only lock parser/listing calls; no installation or archive extraction',
  }
  await json(join(output, 'result.json'), report)
  try {
    for (const control of controls) {
      const projectName = `${control.framework}-typescript`
      const manifestName = `original/${projectName}/package.json`
      const seedName = `logs/create-${projectName}.bun.lock`
      const manifest = await Bun.file(join(input, manifestName)).text()
      const seed = await Bun.file(join(input, seedName)).text()
      inputs[manifestName] = await fileDigest(join(input, manifestName))
      inputs[seedName] = await fileDigest(join(input, seedName))
      ensure(
        isDeepStrictEqual(
          inputs[manifestName],
          originalResult.cases[projectName].generated['package.json']
        ) &&
          isDeepStrictEqual(
            inputs[seedName],
            originalResult.cases[projectName].generated['bun.lock']
          ),
        'Retained generated input bytes differ'
      )
      const original = Bun.JSONC.parse(seed)
      verifyConsumerLock(original, set.consumers[control.framework].lock)
      const local = consumerArchiveLock(set, control.framework)
      const manifestFields = JSON.parse(manifest)
      ensure(
        isDeepStrictEqual(manifestFields.overrides, local.overrides),
        'Retained manifest override mismatch'
      )
      const corrected = seedConsumerLock(
        set.consumers[control.framework].lock,
        {
          name: manifestFields.name,
          dependencies: manifestFields.dependencies,
          devDependencies: manifestFields.devDependencies,
        },
        local
      )
      verifyConsumerLock(corrected, set.consumers[control.framework].lock, false, local)
      const directory = join(output, control.name)
      await mkdir(directory)
      await mkdir(join(directory, 'cache'))
      await writeFile(join(directory, 'package.json'), manifest, { flag: 'wx' })
      await writeFile(
        join(directory, 'bun.lock'),
        control.corrected ? JSON.stringify(corrected, null, 2) + '\n' : seed,
        { flag: 'wx' }
      )
    }
    const started = performance.now()
    for (const control of controls) {
      const directory = join(output, control.name)
      const before = await inventory(directory)
      const command = [process.execPath, 'pm', 'ls', '--all']
      Object.assign(control, { command, cwd: directory, before, status: 'starting' })
      await json(join(output, 'result.json'), report)
      ensure(
        performance.now() - started <= 35_000,
        'Insufficient budget for a full 10-second parser call'
      )
      const begin = performance.now()
      const result = Bun.spawnSync(command, {
        cwd: directory,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          BUN_INSTALL_CACHE_DIR: join(directory, 'cache'),
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      })
      await writeFile(join(output, `${control.name}.stdout.log`), result.stdout, { flag: 'wx' })
      await writeFile(join(output, `${control.name}.stderr.log`), result.stderr, { flag: 'wx' })
      const after = await inventory(directory)
      const outcome = {
        command,
        cwd: directory,
        elapsedMs: performance.now() - begin,
        exitCode: result.exitCode,
        signal: result.signalCode ?? null,
        before,
        after,
        stdout: await fileDigest(join(output, `${control.name}.stdout.log`)),
        stderr: await fileDigest(join(output, `${control.name}.stderr.log`)),
      }
      Object.assign(control, outcome, { status: 'failed' })
      await json(join(output, 'result.json'), report)
      ensure(
        isDeepStrictEqual(before, after),
        `Parser command changed its owned files: ${control.name}`
      )
      const stdout = result.stdout.toString()
      const stderr = result.stderr.toString()
      ensure(
        !result.signalCode && result.exitCode === (control.corrected ? 0 : 1),
        `Unexpected parser exit: ${control.name}`
      )
      ensure(
        !/Ignoring lockfile|Resolving dependencies|Saved lockfile/.test(stdout + stderr),
        'Parser entered an installer fallback'
      )
      if (control.corrected) {
        for (const name of Object.keys(consumerArchiveLock(set, control.framework).packages))
          ensure(stdout.includes(name), `Parser did not list ${name}`)
        ensure(
          stdout.includes('@babel/helper-module-imports@7.18.6'),
          'Parser lost the nested original helper version'
        )
      } else {
        ensure(
          stderr.includes("Failed to resolve root dev dependency '@bun-native/cli'") &&
            stderr.includes('failed to parse lockfile: InvalidLockfile'),
          'Missing the expected original lock rejection'
        )
      }
      control.status = 'passed'
      await json(join(output, 'result.json'), report)
    }
    ensure(performance.now() - started <= 45_000, 'Overall parser budget exceeded')
    report['status'] = 'passed'
  } catch (error) {
    report['status'] = 'failed'
    report['error'] = String(error)
  } finally {
    try {
      report['sourceAfter'] = await sourceSnapshot()
      report['compilerAfter'] = await fileDigest(process.execPath)
      report['inputsAfter'] = Object.fromEntries(
        await Promise.all(
          Object.keys(inputs).map(async (name) => [name, await fileDigest(join(input, name))])
        )
      )
      ensure(
        isDeepStrictEqual(source, report['sourceAfter']) &&
          isDeepStrictEqual(compiler, report['compilerAfter']) &&
          isDeepStrictEqual(inputs, report['inputsAfter']),
        'Parser control source/compiler/input invariance failed'
      )
    } catch (error) {
      report['status'] = 'failed'
      report['finalizationError'] = String(error)
    }
    await json(join(output, 'result.json'), report)
  }
  console.log(
    JSON.stringify({
      status: report['status'],
      output,
      controls: controls.map(({ name, status }) => ({ name, status })),
    })
  )
  if (report['status'] !== 'passed') process.exitCode = 1
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
