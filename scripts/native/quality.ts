import { join, relative, sep } from 'node:path'
// Package the template style with the CLI so standalone projects without their own config use it.
import '../../.oxfmtrc.json'
import type { Project } from './project.ts'

/** The style the generated templates use; projects with a discoverable config keep theirs. */
export const templateFormatterConfig = join(import.meta.dir, '../../.oxfmtrc.json')

export type QualityStep = {
  name: 'typecheck' | 'format'
  command: string[]
  exitCode: number
  output: string
}

function run(project: Project, args: string[]): Omit<QualityStep, 'name'> {
  const command = [process.execPath, ...args]
  const result = Bun.spawnSync(command, {
    cwd: project.directory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  return {
    command,
    exitCode: result.exitCode ?? 1,
    output: (result.stdout.toString() + result.stderr.toString()).trimEnd(),
  }
}

/** Arguments for the built-in formatter, never a same-named package script. */
export function formatArguments(project: Project, check: boolean): string[] {
  const entry = relative(project.directory, project.entry).split(sep).join('/')
  const discovered = Bun.spawnSync(
    [process.execPath, 'fmt', '--no-script', '--find-config-path', entry],
    { cwd: project.directory, stdout: 'ignore', stderr: 'ignore' }
  )
  const args = ['--no-install', 'fmt', '--no-script', '--no-color']
  if (check) args.push('--check')
  if (discovered.exitCode !== 0) args.push('--config', templateFormatterConfig)
  // Package archives and their canonical manifest are verified by digest, never reformatted.
  if (project.packageSet) args.push('--ignore-pattern', 'vendor/**')
  args.push('.')
  return args
}

export function formatProject(project: Project, check: boolean): QualityStep {
  return { name: 'format', ...run(project, formatArguments(project, check)) }
}

/** Built-in type checking, then formatting; both steps always run so one report covers both. */
export function checkProject(project: Project): QualityStep[] {
  return [
    {
      name: 'typecheck',
      ...run(project, ['--no-install', 'check', '--no-script', '--no-pretty']),
    },
    formatProject(project, true),
  ]
}
