import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const workflows = join(root, '.github/workflows')

type Step = {
  id?: string
  name?: string
  if?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}
type Job = { steps?: Step[] }
type Action = {
  inputs: Record<string, { default?: string }>
  outputs: Record<string, { value: string }>
  runs: { using: string; steps: Step[] }
}

const action = Bun.YAML.parse(
  readFileSync(join(root, '.github/actions/native-toolchain/action.yml'), 'utf8')
) as Action

function jobs(): [string, Job][] {
  return readdirSync(workflows)
    .filter((name) => name.endsWith('.yml'))
    .flatMap((name) => {
      const parsed = Bun.YAML.parse(readFileSync(join(workflows, name), 'utf8')) as {
        jobs: Record<string, Job>
      }
      return Object.entries(parsed.jobs).map(([job, value]): [string, Job] => [
        `${name}#${job}`,
        value,
      ])
    })
}

test('the shared toolchain action installs, caches and restores in one place', () => {
  expect(action.runs.using).toBe('composite')
  const step = (name: string) => {
    const found = action.runs.steps.find((candidate) => candidate.name === name)
    expect(found).toBeDefined()
    return found!
  }
  expect(step('Install checksum-pinned Bun compiler').run).toContain('scripts/install-bun.mjs')
  expect(step('Install pinned Rust toolchain').run).toBe('rustup show active-toolchain')
  const downloads = step('Restore Bun and Cargo downloads')
  expect(downloads.uses).toMatch(/^actions\/cache@[0-9a-f]{40}$/)
  expect(String(downloads.with?.key)).toStartWith('downloads-${{ runner.os }}-${{ runner.arch }}-')
  // Any job may save a missed key first, so the saved set must be complete.
  expect(step('Fetch every locked crate for this host into a new download cache').if).toContain(
    "steps.downloads.outputs.cache-hit != 'true'"
  )
  expect(step('Install locked workspace packages').run).toBe('bun install --frozen-lockfile')
  const target = step('Restore release dependency build outputs')
  expect(target.uses).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}$/)
  expect(target.if).toContain("github.event_name != 'schedule'")
  expect(String(target.with?.['restore-keys'])).toContain("github.event_name == 'pull_request'")
  expect(step('Name the release dependency build outputs').run).toContain(
    "hashFiles('rust-toolchain.toml', 'Cargo.lock', 'Cargo.toml', 'native/vendor/**')"
  )
  expect(step('Keep exact-hit vendored crates fresh').if).toBe(
    "steps.target-cache.outputs.cache-hit == 'true'"
  )
  expect(step("Keep the runner's Cargo home path out of native binaries").run).toContain(
    'CARGO_ENCODED_RUSTFLAGS=--remap-path-prefix='
  )
  for (const step of action.runs.steps) if (step.run) expect(step).toHaveProperty('shell', 'bash')
  expect(action.inputs['cold-on-schedule']?.default).toBe('true')
  expect(Object.keys(action.outputs).sort()).toEqual([
    'target-cache-hit',
    'target-cache-key',
    'target-cache-matched-key',
  ])
})

test('no workflow job copies the toolchain, download cache or release target restore', () => {
  const copies: string[] = []
  for (const [name, job] of jobs())
    for (const step of job.steps ?? []) {
      const key = String(step.with?.key ?? '')
      if (/^(?:gpui-|native-)?downloads-/.test(key)) copies.push(`${name}: download cache`)
      if (
        step.uses?.startsWith('actions/cache/restore@') &&
        key.startsWith('native-release-target')
      )
        copies.push(`${name}: release target restore`)
      if (step.run?.trim() === 'bun install --frozen-lockfile' && name.match(/native|bun-native/))
        copies.push(`${name}: bun install`)
      if (step.run?.includes('rustup show active-toolchain') && !name.includes('bridge-pairs'))
        copies.push(`${name}: rustup`)
    }
  expect(copies).toEqual([])
})

test('every protected-main release target save uses the restore key of its own job', () => {
  let saves = 0
  for (const [name, job] of jobs()) {
    const steps = job.steps ?? []
    for (const step of steps) {
      if (!step.uses?.startsWith('actions/cache/save@')) continue
      if (!String(step.with?.path).includes('target/release/build')) continue
      saves++
      const toolchain = steps.find(
        (candidate) => candidate.uses === './.github/actions/native-toolchain'
      )
      expect({ name, id: toolchain?.id, release: toolchain?.with?.['release-target'] }).toEqual({
        name,
        id: 'toolchain',
        release: 'true',
      })
      expect(step.with?.key).toBe('${{ steps.toolchain.outputs.target-cache-key }}')
      expect(step.if).toContain("steps.toolchain.outputs.target-cache-hit != 'true'")
      expect(step.if).toContain("github.ref == 'refs/heads/main'")
    }
  }
  expect(saves).toBe(4)
})
