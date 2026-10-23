/** Execute the maintained renderer -> native -> Bun RPC fixture in a prepared app. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { acceptNativeRpcSuite } from '../benchmarks/lib/cef-rpc-acceptance.ts'

const artifact = process.argv[2]
if (!artifact) throw new Error('Usage: bun run qualify:cef-rpc -- /path/to/prepared-native-app')
const child = Bun.spawn(
  [
    process.execPath,
    resolve(import.meta.dir, 'qualify-cef-prebuilt.ts'),
    resolve(artifact),
    ...process.argv.slice(3),
  ],
  {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'inherit',
    // Fixture-only requirement, never a runtime authority/debugging switch.
    env: { ...process.env, BUNLY_RPC_QUALIFICATION: '1' },
  }
)
const output = await new Response(child.stdout).text()
const status = await child.exited
process.stdout.write(output)
assert.equal(status, 0, 'Prepared CEF RPC qualification failed')
const summaries = output
  .trim()
  .split('\n')
  .map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return null
    }
  })
  .filter((value): value is Record<string, unknown> => value !== null)
const summary = summaries[summaries.length - 1]
assert.equal(summary?.['passed'], true, 'Prepared CEF RPC qualification did not pass')
assert.equal(typeof summary?.['output'], 'string', 'Prepared CEF RPC report path is missing')
const report = JSON.parse(await readFile(String(summary!['output']), 'utf8')) as {
  trials?: { name?: unknown; observation?: unknown }[]
}
const successfulTrials = (report.trials ?? []).filter(
  (trial) =>
    typeof trial.name === 'string' &&
    (trial.name.startsWith('installed-') ||
      trial.name === 'last-window' ||
      trial.name === 'restored-installation')
)
const acceptance = acceptNativeRpcSuite(successfulTrials, process.platform === 'darwin')

// This final result is emitted only after the stronger RPC/teardown gate passes.
console.log(
  JSON.stringify({
    profile: 'native-rpc',
    passed: true,
    ...acceptance,
    output: summary!['output'],
  })
)
