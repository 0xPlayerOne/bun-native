import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
// Package the template lint rules with the CLI so projects without their own config use them.
import '../../.oxlintrc.json'
// Importing the manifest makes oxlint a pinned dependency of the packaged CLI.
import oxlint from 'oxlint/package.json'
import type { Project } from './project.ts'
import { runQualityStep, type QualityStep } from './quality.ts'

/** The rules the generated templates satisfy; a project's own `.oxlintrc.json` replaces them. */
export const templateLinterConfig = join(import.meta.dir, '../../.oxlintrc.json')

/** Generated build output and development bundles are never linted. */
const generatedOutput = ['dist/**', '.bun-native/**', 'node_modules/**']

/** The CLI's own pinned oxlint, resolved from the CLI location rather than the project. */
function linterEntry(): string {
  const manifest = Bun.resolveSync('oxlint/package.json', import.meta.dir)
  return join(dirname(manifest), oxlint.bin.oxlint)
}

/** Arguments for the pinned linter with deterministic, uncoloured line output. */
export function lintArguments(project: Project): string[] {
  const own = join(project.directory, '.oxlintrc.json')
  const args = [
    '--no-install',
    linterEntry(),
    '--config',
    existsSync(own) ? own : templateLinterConfig,
    '--deny-warnings',
    '--format',
    'unix',
  ]
  // Package archives and their canonical manifest are verified by digest, never linted.
  const ignored = project.packageSet ? [...generatedOutput, 'vendor/**'] : generatedOutput
  for (const pattern of ignored) args.push('--ignore-pattern', pattern)
  args.push('.')
  return args
}

export async function lintProject(project: Project): Promise<QualityStep> {
  return { name: 'lint', ...(await runQualityStep(project, lintArguments(project))) }
}
