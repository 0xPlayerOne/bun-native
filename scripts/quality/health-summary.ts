#!/usr/bin/env bun
import { resolve } from 'node:path'
import { checkBoundaries } from './boundaries.ts'
import { findDeadReferences } from './dead-references.ts'
import { checkDuplicates } from './duplicate-dependencies.ts'
import { checkSourceHealth } from './source-health.ts'

/**
 * Concise code-health summary for CI (#259): one row per check with its
 * outcome, the first findings with their exact path, and the command that
 * reproduces it. Written to the job summary of Source quality, so a reviewer or
 * agent can read the next fix without opening logs.
 *
 *   bun scripts/quality/health-summary.ts [ROOT] >> "$GITHUB_STEP_SUMMARY"
 *
 * Exits 1 when any check has findings or could not run.
 */

export type Check = {
  name: string
  command: string
  run: (root: string) => Promise<string[]> | string[]
}

export const CHECKS: Check[] = [
  {
    name: 'Package boundaries and runtime dependencies',
    command: 'bun run check:boundaries',
    run: checkBoundaries,
  },
  {
    name: 'Unreachable source and unused internal exports',
    command: 'bun run check:health',
    run: checkSourceHealth,
  },
  {
    name: 'Duplicate dependency versions',
    command: 'bun run check:duplicates',
    run: checkDuplicates,
  },
  {
    name: 'Dead script, workflow and docs references',
    command: 'bun scripts/quality/dead-references.ts',
    run: findDeadReferences,
  },
]

const SHOWN = 10

function cell(text: string) {
  return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export async function healthSummary(
  root: string,
  checks: readonly Check[] = CHECKS
): Promise<{ markdown: string; failed: boolean }> {
  const rows: string[] = []
  const details: string[] = []
  let failed = false
  for (const check of checks) {
    let findings: string[]
    try {
      findings = await check.run(root)
    } catch (error) {
      findings = [
        `the check could not run: ${error instanceof Error ? error.message : String(error)}`,
      ]
    }
    failed ||= findings.length > 0
    rows.push(
      `| ${check.name} | ${findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'clean'} | \`${check.command}\` |`
    )
    if (findings.length) {
      details.push('', `### ${check.name}`, '')
      for (const finding of findings.slice(0, SHOWN)) details.push(`- ${cell(finding)}`)
      if (findings.length > SHOWN)
        details.push(`- ... ${findings.length - SHOWN} more; run \`${check.command}\``)
    }
  }
  const markdown = [
    '## Code health',
    '',
    '| Check | Result | Reproduce |',
    '| --- | --- | --- |',
    ...rows,
    ...details,
  ].join('\n')
  return { markdown, failed }
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dir, '../..'))
  const { markdown, failed } = await healthSummary(root)
  console.log(markdown)
  if (failed) process.exitCode = 1
}
