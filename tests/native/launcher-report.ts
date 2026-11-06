import { existsSync, readFileSync } from 'node:fs'

/** Longest slice of any one captured stream kept in a failure message. */
export const STREAM_LIMIT = 4_096

/** The final `limit` characters of a stream, with a marker naming what was cut. */
export function boundedTail(text: string, limit: number = STREAM_LIMIT): string {
  if (text.length <= limit) return text
  return `[${text.length - limit} earlier characters omitted]\n${text.slice(-limit)}`
}

export type LauncherRun = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

function describe(run: LauncherRun, reportFile: string, report: string | undefined): string {
  return [
    `launcher exit status: ${run.exitCode === null ? 'none (killed or timed out)' : run.exitCode}`,
    `report file: ${reportFile} (${report === undefined ? 'not written' : `${report.length} characters`})`,
    `--- report file (tail) ---\n${report === undefined ? '' : boundedTail(report)}`,
    `--- launcher stdout (tail) ---\n${boundedTail(run.stdout)}`,
    `--- launcher stderr (tail) ---\n${boundedTail(run.stderr)}`,
  ].join('\n')
}

/**
 * Reads the JSON report an application wrote to its own file. The launcher's
 * stdout and stderr stay out of the parse; they only appear, separately
 * labelled and bounded, with the exit status when the report is missing or is
 * not a JSON line (#530).
 */
export function readLauncherReport<T>(run: LauncherRun, reportFile: string, what: string): T {
  const text = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : undefined
  const line = text?.trim().split('\n').at(-1)
  if (line === undefined || line === '')
    throw new Error(`${what} wrote no report.\n${describe(run, reportFile, text)}`)
  try {
    return JSON.parse(line) as T
  } catch (error) {
    throw new Error(
      `${what} report is not JSON (${error instanceof Error ? error.message : String(error)}).\n${describe(run, reportFile, text)}`,
      { cause: error }
    )
  }
}
