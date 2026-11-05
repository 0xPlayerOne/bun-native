import { isAbsolute, join, relative, resolve, sep, dirname } from 'node:path'
import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { captureDevelopmentModule, developmentModuleCleanup } from './cli-module-evidence.ts'
import { observeTemplate } from './cli-template-owner.ts'

// The Python producer validates the complete installed package inventories and
// captured build inputs before this observer imports any consumer source.
const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    report: { type: 'string' },
    project: { type: 'string' },
    host: { type: 'string' },
    mode: { type: 'string' },
    executable: { type: 'string' },
    artifact: { type: 'string', multiple: true },
  },
})
if (
  !values.report ||
  !values.project ||
  !values.host ||
  !['development', 'aot'].includes(values.mode ?? '')
)
  throw new Error('--report, --project, --host and --mode development|aot are required')
for (const path of [values.report, values.project, values.host])
  if (!isAbsolute(path)) throw new Error('Installed qualification paths must be absolute')
const project = realpathSync(values.project)
const host = realpathSync(values.host)
const repository = resolve(import.meta.dir, '../..')
const inside = (parent: string, path: string) => {
  const local = relative(parent, path)
  return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}
if (project === repository || inside(repository, project))
  throw new Error('Installed consumer must be outside the source checkout')
let command: string[]
if (values.mode === 'development') {
  const cli = realpathSync(join(project, 'node_modules/@bun-native/cli/src/scripts/native.ts'))
  if (!inside(project, cli)) throw new Error('Installed CLI resolves outside the consumer')
  command = [process.execPath, '--no-install', cli, 'dev', project, '--host', host]
} else {
  if (!values.executable || !isAbsolute(values.executable))
    throw new Error('AOT requires an absolute inspected executable')
  const executable = realpathSync(values.executable)
  if (!inside(project, executable) || dirname(executable) !== dirname(host))
    throw new Error('AOT must use the consumer executable and its adjacent host')
  command = [executable]
}
const environment: Record<string, string | undefined> = {
  ...process.env,
  BUN_NATIVE_HOST_PROFILE: 'release',
}
delete environment.BUN_NATIVE_HOST
let module: ReturnType<typeof captureDevelopmentModule> | undefined
const report = await observeTemplate(
  command,
  environment,
  values.artifact ?? [],
  35_000,
  values.mode === 'development'
    ? () => {
        module = captureDevelopmentModule(
          project,
          join(dirname(values.report!), 'native-dev-module')
        )
      }
    : undefined
)
const cleanup =
  values.mode === 'development' ? developmentModuleCleanup(project, module) : undefined
if (cleanup && !cleanup.removed) {
  report.status = 'failed'
  report.error ??= 'Installed native dev did not remove its temporary module before process exit'
}
await writeFile(
  values.report,
  JSON.stringify(
    {
      ...report,
      verification_scope:
        'Installed CLI or adjacent-host AOT, unchanged inputs and joined IPC lifecycle; the shared X11 driver checks native paint and input',
      installed_project: project,
      development_module: module,
      temporary_modules_after_exit: cleanup?.remaining,
      development_module_removed: cleanup?.removed,
    },
    null,
    2
  ) + '\n',
  { flag: 'wx' }
)
process.exitCode = report.status === 'passed' ? 0 : 1
