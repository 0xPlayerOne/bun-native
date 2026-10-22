import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { referenceDesktopTrial } from '../benchmarks/adapters/references/driver.ts'
const [name, installation, lockSha256, destination] = process.argv.slice(2)
if ((name !== 'mirin' && name !== 'butter') || !installation || !lockSha256 || !destination)
  throw new Error(
    'Usage: bun scripts/qualify-reference-app.ts mirin|butter <installed-project> <bun.lock-sha256> <report.json>'
  )
const output = resolve(destination)
await mkdir(dirname(output), { recursive: true })
const report = await referenceDesktopTrial(name, {
  installation: resolve(installation),
  lockSha256,
  output: output + '.commands',
})
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(
  JSON.stringify({
    passed: report.passed,
    adapter: name,
    setupFailure: report.setupFailure,
    output,
  })
)
if (!report.passed) process.exitCode = 1
