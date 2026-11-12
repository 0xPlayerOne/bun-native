import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildRecord,
  EXTRA_SOURCES,
  FEATURES,
  sha256,
} from '../../scripts/quality/macos-feature-evidence.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const COMMIT = 'a'.repeat(40)

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** A checkout, host and evidence tree that satisfy every macOS feature. */
function passingTree() {
  const root = mkdtempSync(join(tmpdir(), 'macos-feature-evidence-'))
  roots.push(root)
  const source = join(root, 'source')
  const evidence = join(root, 'evidence')
  const host = join(root, 'bun-native-host')
  for (const path of [...EXTRA_SOURCES, 'tests/native/fixture.ts'])
    write(join(source, path), `// ${path}\n`)
  write(host, 'host binary')
  for (const feature of FEATURES) {
    for (const report of feature.reports)
      write(
        join(evidence, report.path),
        JSON.stringify({
          ...report.fields,
          outcomes: Object.fromEntries((report.outcomes ?? []).map((name) => [name, true])),
        })
      )
    for (const entry of feature.packages) {
      write(join(evidence, `${entry}-package`, entry), `application ${entry}`)
      write(
        join(evidence, `${entry}-package`, 'manifest.json'),
        JSON.stringify({
          application: {
            file: entry,
            bytes: 1,
            sha256: sha256(join(evidence, `${entry}-package`, entry)),
          },
          host: { sha256: sha256(host), profile: 'release' },
          source: {
            commit: COMMIT,
            files: [
              {
                path: 'tests/native/fixture.ts',
                bytes: 1,
                sha256: sha256(join(source, 'tests/native/fixture.ts')),
              },
            ],
          },
        })
      )
    }
  }
  return {
    source,
    evidence,
    host,
    commit: COMMIT,
    tree: 'b'.repeat(40),
    dirty: [],
    run: { runId: '1' },
  }
}

test('every advertised macOS feature that M1 and M2 name has an expected report', () => {
  const capabilities = FEATURES.flatMap((feature) => feature.capabilities).sort()
  expect(capabilities).toEqual(
    [
      'accessibility_v1',
      'app_menu_v1',
      'context_menus_v1',
      'display_details_v1',
      'drag_drop_files_v1',
      'filesystem_grants_v1',
      'focus_v1',
      'input_states_v1',
      'overlay_keyboard_v1',
      'overlays_v1',
      'processes_v1',
      'scroll_anchor_v1',
      'scroll_control_v1',
      'split_resize_v1',
      'split_v1',
      'style_decoration_v1',
      'task_dialogs_v1',
      'clipboard_text_v1',
      'global_shortcuts_v1',
      'file_dialogs_v1',
      'popup_windows_v1',
      'notifications_v1',
    ].sort()
  )
  for (const feature of FEATURES) expect(feature.reports.length).toBeGreaterThan(0)
})

test('a complete, source-matched evidence tree passes and binds every file', () => {
  const inputs = passingTree()
  const record = buildRecord(inputs)
  expect(record.failures).toEqual([])
  expect(record.status).toBe('passed')
  expect(record.features.every((feature) => feature.status === 'passed')).toBe(true)
  expect(Object.keys(record.source.filesSha256)).toContain('tests/native/fixture.ts')
  expect(Object.keys(record.source.filesSha256)).toContain('.github/workflows/native-platforms.yml')
  expect(record.host?.sha256).toBe(sha256(inputs.host))
})

test('a report that is missing, unverified, Linux or short of outcomes fails the record', () => {
  const inputs = passingTree()
  rmSync(join(inputs.evidence, 'overlays-aot/overlays.json'))
  write(
    join(inputs.evidence, 'app-menu-development/app-menu.json'),
    JSON.stringify({ status: 'unverified', platform: 'darwin', mode: 'development' })
  )
  write(
    join(inputs.evidence, 'processes-aot/processes.json'),
    JSON.stringify({ backend: 'posix', mode: 'development' })
  )
  const record = buildRecord(inputs)
  expect(record.status).toBe('failed')
  expect(record.failures).toContain('overlays-aot/overlays.json: missing')
  expect(record.failures.join('\n')).toContain(
    'app-menu-development/app-menu.json: status="unverified" (want "verified")'
  )
  expect(record.failures.join('\n')).toContain(
    'app-menu-development/app-menu.json: outcomes missing'
  )
  expect(record.failures.join('\n')).toContain('processes-aot/processes.json: mode="development"')
})

test('an AOT package built from other sources, another host or a changed binary fails', () => {
  const inputs = passingTree()
  writeFileSync(join(inputs.source, 'tests/native/fixture.ts'), '// edited after the build\n')
  writeFileSync(join(inputs.evidence, 'overlays-package/overlays'), 'replaced')
  const record = buildRecord({ ...inputs, commit: 'c'.repeat(40) })
  const failures = record.failures.join('\n')
  expect(failures).toContain(
    'overlays: AOT sources differ from the checkout: tests/native/fixture.ts'
  )
  expect(failures).toContain('overlays: the AOT application differs from its manifest')
  expect(failures).toContain(`overlays: AOT source commit ${COMMIT} is not ${'c'.repeat(40)}`)
  writeFileSync(inputs.host, 'another host')
  expect(buildRecord(inputs).failures.join('\n')).toContain(
    'overlays: AOT package names another host or profile'
  )
})

type Step = { name?: string; if?: string; run?: string; 'continue-on-error'?: unknown }
const steps = (
  Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../../.github/workflows/native-platforms.yml'), 'utf8')
  ) as { jobs: { native: { steps: Step[] } } }
).jobs.native.steps

test('the macOS feature steps gate on shard 2 and feed one record step', () => {
  const index = (prefix: string) => {
    const at = steps.findIndex((step) => step.name?.startsWith(prefix))
    expect(at).toBeGreaterThanOrEqual(0)
    return at
  }
  const features = [
    'macOS development and AOT overlays',
    'macOS shared layout, split panes and theme tokens',
    'macOS development and AOT accessibility roles, keyboard and pointer split divider',
    'macOS development and AOT read-only and disabled inputs',
    'macOS development and AOT application menu bar',
    'macOS OS message dialogs through NSAlert sheets',
    'macOS OS context menus through NSMenu pop-ups',
    'Display snapshot, work area, identity and display-change qualification',
    'macOS and Windows development and AOT filesystem grants',
    'Development and AOT owned processes',
    'Development and AOT OS drag and drop through core, Solid and React',
  ].map(index)
  const record = index('Record source-bound macOS feature evidence')
  for (const at of [...features, record]) {
    const step = steps[at]!
    expect(step['continue-on-error']).toBeUndefined()
    // Every one runs (and so is recorded) on the macOS shard 2 job.
    expect(step.if ?? '').not.toContain('matrix.shard == 1')
    if (at !== record) expect(record).toBeGreaterThan(at)
  }
  for (const at of features.slice(0, 4)) expect(steps[at]!.if).toContain('matrix.shard == 2')
  // The record runs on both macOS shards and checks the shard's own features.
  expect(steps[record]!.if ?? '').not.toContain('matrix.shard')
  expect(steps[record]!.run).toContain('--shard ${{ matrix.shard }}')
  expect(steps[record]!.if).toContain("runner.os == 'macOS'")
  expect(steps[record]!.run).toContain('scripts/quality/macos-feature-evidence.ts')
  expect(steps[record]!.run).toContain('throw')
  const menu = steps[index('macOS development and AOT application menu bar')]!.run!
  expect(menu).not.toContain('::warning::')
  expect(menu).toContain('if (-not $trust.trusted) { throw')
  expect(menu).toContain('throw "macOS $mode menu bar contents and selections are unverified')
})

test('the macOS service steps gate on shard 1 before the record, one feature each', () => {
  const services = [
    ['macOS clipboard text through the general pasteboard', 'clipboard_text_v1'],
    ['macOS global shortcuts through Carbon hot keys', 'global_shortcuts_v1'],
    ['macOS file dialogs through NSOpenPanel and NSSavePanel sheets', 'file_dialogs_v1'],
    ['macOS popup windows as owned child panels', 'popup_windows_v1'],
    [
      "macOS user notifications from the bare host and the installed template's",
      'notifications_v1',
    ],
  ] as const
  const record = steps.findIndex(
    (step) => step.name === 'Record source-bound macOS feature evidence'
  )
  for (const [prefix, capability] of services) {
    const at = steps.findIndex((step) => step.name?.startsWith(prefix))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(record)
    const step = steps[at]!
    expect(step['continue-on-error']).toBeUndefined()
    expect(step.if).toContain('matrix.shard == 1')
    expect(step.if).toContain("runner.os == 'macOS'")
    expect(step.run).toContain('throw')
    const feature = FEATURES.find((entry) => entry.capabilities.includes(capability))!
    expect(feature.shard).toBe(1)
    for (const report of feature.reports)
      expect(step.run).toContain(`'${report.path.split('/')[0]}'`)
  }
  // Notifications use the host the signed template image installed.
  const notifications = steps.find((step) => step.name?.startsWith(services[4][0]))!
  expect(notifications.if).toContain("steps.signed-install.outcome == 'success'")
  expect(notifications.run).toContain('installedHost.executable')
  const install = steps.find((step) => step.name?.startsWith('Install the signed template'))!
  expect((install as { id?: string }).id).toBe('signed-install')
})

test('a shard record checks only that shard and passes without the other shard', () => {
  const inputs = passingTree()
  const shardOne = FEATURES.filter((feature) => feature.shard === 1)
  for (const feature of FEATURES)
    if (feature.shard !== 1)
      for (const report of feature.reports) rmSync(join(inputs.evidence, report.path))
  const first = buildRecord({ ...inputs, shard: 1 })
  expect(first.failures).toEqual([])
  expect(first.shard).toBe(1)
  expect(first.features.map((feature) => feature.capabilities)).toEqual(
    shardOne.map((feature) => feature.capabilities)
  )
  const second = buildRecord({ ...inputs, shard: 2 })
  expect(second.status).toBe('failed')
  rmSync(join(inputs.evidence, shardOne[0]!.reports[0]!.path))
  expect(buildRecord({ ...inputs, shard: 1 }).failures).toEqual([
    `${shardOne[0]!.reports[0]!.path}: missing`,
  ])
})
