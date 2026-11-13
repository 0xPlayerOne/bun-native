import { join, relative, sep } from 'node:path'
// Package the template style with the CLI so standalone projects without their own config use it.
import '../../.oxfmtrc.json'
import type { Project } from './project.ts'

/** The style the generated templates use; projects with a discoverable config keep theirs. */
export const templateFormatterConfig = join(import.meta.dir, '../../.oxfmtrc.json')

export type QualityStep = {
  name: 'typecheck' | 'format' | 'lint'
  command: string[]
  exitCode: number
  output: string
}

/** A quality step that runs longer than this is killed and reported as failed. */
const STEP_TIMEOUT_MS = 10 * 60_000

/**
 * Runs the pinned Bun with `args` in the project directory and captures its combined
 * output. Asynchronous, so `check` runs its steps concurrently; callers print the
 * results in a fixed order.
 */
export async function runQualityStep(
  project: Project,
  args: string[]
): Promise<Omit<QualityStep, 'name'>> {
  const command = [process.execPath, ...args]
  const child = Bun.spawn(command, {
    cwd: project.directory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: STEP_TIMEOUT_MS,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {
    command,
    exitCode: child.signalCode ? 1 : exitCode,
    output: (stdout + stderr).trimEnd(),
  }
}

/** Arguments for the built-in formatter, never a same-named package script. */
export async function formatArguments(project: Project, check: boolean): Promise<string[]> {
  const entry = relative(project.directory, project.entry).split(sep).join('/')
  const discovered = await Bun.spawn(
    [process.execPath, 'fmt', '--no-script', '--find-config-path', entry],
    { cwd: project.directory, stdout: 'ignore', stderr: 'ignore', timeout: STEP_TIMEOUT_MS }
  ).exited
  const args = ['--no-install', 'fmt', '--no-script', '--no-color']
  if (check) args.push('--check')
  if (discovered !== 0) args.push('--config', templateFormatterConfig)
  // Package archives and their canonical manifest are verified by digest, never reformatted.
  if (project.packageSet) args.push('--ignore-pattern', 'vendor/**')
  args.push('.')
  return args
}

export async function formatProject(project: Project, check: boolean): Promise<QualityStep> {
  return {
    name: 'format',
    ...(await runQualityStep(project, await formatArguments(project, check))),
  }
}

/** Built-in type checking and the formatter check, run together; one report covers both. */
export async function checkProject(project: Project): Promise<QualityStep[]> {
  const typecheck = runQualityStep(project, ['--no-install', 'check', '--no-script', '--no-pretty'])
  const format = formatProject(project, true)
  return [{ name: 'typecheck', ...(await typecheck) }, await format]
}
