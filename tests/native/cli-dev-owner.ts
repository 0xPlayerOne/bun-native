import { constants, existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { observeTemplate } from './cli-template-owner.ts'
import {
  captureDevelopmentModule,
  developmentModuleCleanup,
  fingerprint,
  regularFiles,
} from './cli-module-evidence.ts'

const repository = resolve(import.meta.dir, '../..')
const nativeTools = ['cargo', 'rustc', 'rustup'] as const

/** The X11 supervisor launches this owner before it creates any temporary project. */
export async function observeDevelopmentTemplate(
  source: string,
  host: string,
  retainedModule: string,
  environment: Record<string, string | undefined>,
  artifacts: readonly string[],
  timeoutMs = 35_000
) {
  if (process.platform !== 'linux') throw new Error('Native dev qualification requires Linux')
  const cache = join(repository, '.bun-native')
  await mkdir(cache, { recursive: true })
  const owned = await mkdtemp(join(cache, 'cli-native-dev-'))
  // Preserve the original generated project's checkout depth and every byte,
  // including its relative check/dev paths. Never add a template test callback.
  const project = join(owned, 'project')
  const tools = join(owned, 'native-tool-sentinels')
  const invocationLog = join(owned, 'native-tool-invocations.txt')
  let module: ReturnType<typeof captureDevelopmentModule> | undefined
  let report: Awaited<ReturnType<typeof observeTemplate>>
  let remainingBundles: string[]
  let invocations: string
  let sourceFiles: ReturnType<typeof fingerprint>[]
  let generatedFiles: ReturnType<typeof fingerprint>[]
  let sentinels: ReturnType<typeof fingerprint>[]
  try {
    await mkdir(project)
    const names = regularFiles(source)
    if (!names.includes('bun-native.json')) throw new Error('Generated project config is missing')
    sourceFiles = names.map((name) => fingerprint(join(source, name)))
    for (const name of names)
      await copyFile(join(source, name), join(project, name), constants.COPYFILE_EXCL)
    generatedFiles = names.map((name) => fingerprint(join(project, name)))
    if (sourceFiles.some((item, index) => item.sha256 !== generatedFiles[index]?.sha256))
      throw new Error('Generated project copy differs from its prepared source')
    await mkdir(tools)
    await writeFile(invocationLog, '', { flag: 'wx' })
    for (const name of nativeTools) {
      const path = join(tools, name)
      await writeFile(
        path,
        '#!/bin/sh\nprintf "%s\\n" "$0" >> "$BUN_NATIVE_TOOL_INVOCATIONS"\nexit 86\n',
        { flag: 'wx' }
      )
      await chmod(path, 0o755)
    }
    sentinels = nativeTools.map((name) => fingerprint(join(tools, name)))
    const cli = join(repository, 'scripts/native.ts')
    report = await observeTemplate(
      [process.execPath, cli, 'dev', project, '--host', host],
      {
        ...environment,
        PATH: `${tools}${delimiter}${environment['PATH'] ?? ''}`,
        CARGO: join(tools, 'cargo'),
        RUSTC: join(tools, 'rustc'),
        RUSTUP: join(tools, 'rustup'),
        BUN_NATIVE_TOOL_INVOCATIONS: invocationLog,
      },
      [
        ...artifacts,
        cli,
        ...sourceFiles.map((item) => item.path),
        ...generatedFiles.map((item) => item.path),
        ...sentinels.map((item) => item.path),
      ],
      timeoutMs,
      () => {
        module = captureDevelopmentModule(project, retainedModule)
      }
    )
    const cleanup = developmentModuleCleanup(project, module)
    remainingBundles = cleanup.remaining
    invocations = readFileSync(invocationLog, 'utf8')
    if (!cleanup.removed) {
      report.status = 'failed'
      report.error ??= 'native dev did not remove its temporary module before process exit'
    }
    if (invocations.length !== 0) {
      report.status = 'failed'
      report.error ??= 'native dev invoked a Cargo/Rust tool sentinel'
    }
  } finally {
    // Only this freshly created root is removed, after the IPC owner joins its
    // child. CLI module removal is checked separately before this cleanup.
    await rm(owned, { recursive: true, force: true })
  }
  const ownedDirectoryRemoved = !existsSync(owned)
  if (!ownedDirectoryRemoved) {
    report.status = 'failed'
    report.error ??= 'Native dev qualification left its owned project directory after cleanup'
  }
  return {
    ...report,
    verification_scope:
      'Exact native dev command, unchanged generated source, observed temporary module and joined IPC lifecycle; the X11 driver checks native input and paint',
    generated_project: { path: project, source: sourceFiles, files: generatedFiles },
    development_module: module,
    temporary_modules_after_exit: remainingBundles,
    native_tool_sentinels: sentinels,
    native_tool_invocations: invocations,
    no_native_tools_invoked: invocations.length === 0,
    owned_directory: owned,
    owned_directory_removed: ownedDirectoryRemoved,
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      report: { type: 'string' },
      source: { type: 'string' },
      host: { type: 'string' },
      artifact: { type: 'string', multiple: true },
    },
  })
  if (!values.report || !values.source || !values.host)
    throw new Error('--report, --source and --host are required')
  const report = await observeDevelopmentTemplate(
    values.source,
    values.host,
    join(dirname(values.report), 'native-dev-module'),
    process.env,
    values.artifact ?? []
  )
  await writeFile(values.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  process.exitCode = report.status === 'passed' ? 0 : 1
}
