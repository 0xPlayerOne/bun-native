/**
 * Compare layout-style qualification reports: every adapter must commit the
 * same native element tree, and must paint it at the same logical geometry.
 * Reports at different native scales compare their logical geometry within
 * half a logical pixel, because text rasterization may round differently.
 *
 * Usage: bun tests/native/layout-style-compare.ts REPORT.json REPORT.json...
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

type Snapshot = { tree: unknown; geometry: Record<string, number[]> }
type Report = {
  adapter: string
  mode: string
  scale: number
  outcomes: Record<string, unknown>
  snapshots: Record<string, Snapshot>
}

const files = process.argv.slice(2)
if (files.length < 2) throw new Error('Compare at least two layout-style reports')
const reports = files.map((file) => ({
  file,
  report: JSON.parse(readFileSync(file, 'utf8')) as Report,
}))
const [reference, ...others] = reports
const checkpoints = Object.keys(reference!.report.snapshots).sort()
assert.deepEqual(checkpoints, ['declared', 'initial', 'resized'])
for (const { file, report } of others) {
  assert.deepEqual(Object.keys(report.snapshots).sort(), checkpoints, file)
  for (const name of checkpoints) {
    const expected = reference!.report.snapshots[name]!
    const actual = report.snapshots[name]!
    assert.deepEqual(actual.tree, expected.tree, `${file}: ${name} element tree`)
    assert.deepEqual(
      Object.keys(actual.geometry).sort(),
      Object.keys(expected.geometry).sort(),
      `${file}: ${name} painted nodes`
    )
    const tolerance = report.scale === reference!.report.scale ? 0 : 0.5
    for (const [path, bounds] of Object.entries(expected.geometry))
      bounds.forEach((value, index) =>
        assert.ok(
          Math.abs(actual.geometry[path]![index]! - value) <= tolerance,
          `${file}: ${name} ${path} bounds ${JSON.stringify(actual.geometry[path])} vs ${JSON.stringify(bounds)}`
        )
      )
  }
}
console.log(
  JSON.stringify({
    compared: reports.map(({ report }) => `${report.adapter}/${report.mode}/scale-${report.scale}`),
    checkpoints,
    status: 'identical',
  })
)
