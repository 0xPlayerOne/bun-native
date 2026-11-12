import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * The source-bound record of one hosted macOS shard's feature qualification
 * (docs/native-platforms.md, "Advertised capabilities by platform"). It reads
 * the evidence the gating macOS steps of native-platforms.yml wrote, requires
 * every expected report to name macOS, its mode and a pass, and binds them to
 * the exact checkout: each AOT package's recorded source hashes must equal the
 * checked-out files, its application and the release host are rehashed, and
 * every source, oracle, helper and workflow file is hashed into the record.
 * Any missing, failed or mismatched item fails the step; nothing is inferred.
 */

export const MODES = ['development', 'aot'] as const

/** One retained report and what it must say. */
export type Report = {
  path: string
  /** Exact values at dotted key paths. */
  fields: Record<string, unknown>
  /** Keys that must be present in the report's `outcomes`. */
  outcomes?: string[]
}

export type Feature = {
  capabilities: string[]
  /** The macOS shard whose gating steps write the reports; 2 when omitted. */
  shard?: 1 | 2
  /** What on macOS independently observes the effect. */
  oracle: string
  reports: Report[]
  /** AOT packages whose compiled applications produced the AOT reports. */
  packages: string[]
}

const perMode = (build: (mode: (typeof MODES)[number]) => Report) => MODES.map(build)

/** A development-only service report: macOS, not failed, with every named outcome. */
const service = (path: string, outcomes: string[]): Report => ({
  path,
  fields: { platform: 'darwin', failed: false },
  outcomes,
})

const LAYOUT_ADAPTERS = [
  ['layout-style', 'core'],
  ['solid-layout-style', 'solid'],
  ['react-layout-style', 'react'],
] as const

export const FEATURES: Feature[] = [
  {
    capabilities: ['split_v1', 'style_decoration_v1'],
    oracle:
      'CoreGraphics pointer, wheel and key input, Accessibility window resize, screencapture pixels and the host paint evidence; one tree and geometry across core, Solid and React',
    reports: [
      ...LAYOUT_ADAPTERS.flatMap(([entry, adapter]) =>
        perMode((mode) => ({
          path: `layout-${mode}-${entry}/layout-style-${adapter}.json`,
          fields: { platform: 'darwin', adapter, mode },
          outcomes: [
            'splitRatio',
            'paneClipping',
            'focusOrder',
            'paneScroll',
            'dividerDrag',
            'themeSwitch',
            'declaredRatio',
            'resize',
            'ownershipReleased',
          ],
        }))
      ),
      { path: 'layout-style-comparison/report.json', fields: { status: 'identical' } },
    ],
    packages: LAYOUT_ADAPTERS.map(([entry]) => entry),
  },
  {
    capabilities: [
      'overlays_v1',
      'scroll_anchor_v1',
      'focus_v1',
      'scroll_control_v1',
      'overlay_keyboard_v1',
    ],
    oracle: 'CoreGraphics key, click and wheel input; screencapture pixels; host paint evidence',
    reports: perMode((mode) => ({
      path: `overlays-${mode}/overlays.json`,
      fields: { platform: 'darwin', mode },
      outcomes: [
        'editorSelection',
        'modalFocusTrap',
        'backdropBlocksPointer',
        'nestedModalEscape',
        'focusAndSelectionRestored',
        'anchoredPopoverZOrder',
        'controlLessModalEscape',
        'scrollAnchorUnderStreaming',
        'menuArrowNavigation',
        'menuTypeAhead',
        'visibleFocusRing',
        'menuActivationAndReturn',
        'programmaticFocusRevealsTarget',
        'programmaticScroll',
        'tabFocusRevealsTarget',
        'ownershipReleased',
      ],
    })),
    packages: ['overlays'],
  },
  {
    capabilities: ['accessibility_v1', 'split_resize_v1', 'accessibility_lists_v1'],
    oracle:
      'AXUIElement tree and requests and an AXObserver for AXAnnouncementRequested (macos-accessibility-oracle.m), CoreGraphics key and drag input, screencapture focus-ring pixels',
    reports: [
      ...perMode((mode) => ({
        path: `accessibility-${mode}/result.json`,
        fields: { status: 'passed', platform: 'darwin', mode },
        outcomes: [
          'initialTree',
          'characterBounds',
          'assistiveActions',
          'tabOrder',
          'focusRing',
          'keyboardSteps',
          'pointerDrag',
          'dialogTree',
          'modalDialog',
          'lists',
        ],
      })),
      ...perMode((mode) => ({
        path: `accessibility-platform-${mode}/result.json`,
        fields: { status: 'passed', platform: 'darwin', mode },
      })),
    ],
    packages: ['accessibility', 'accessibility-platform'],
  },
  {
    capabilities: ['input_states_v1'],
    oracle: 'CoreGraphics key input; pbpaste; AXUIElement enabled/focusable/focused states',
    reports: perMode((mode) => ({
      path: `input-states-platform-${mode}/result.json`,
      fields: { status: 'passed', platform: 'darwin', mode },
      outcomes: [
        'initialFocus',
        'accessibilityStates',
        'focusOrder',
        'selectionClipboard',
        'disabledState',
      ],
    })),
    packages: ['input-states-platform'],
  },
  {
    capabilities: ['app_menu_v1'],
    oracle: 'AXMenuBar dump and AXPress (macos-menu-oracle.m)',
    reports: perMode((mode) => ({
      path: `app-menu-${mode}/app-menu.json`,
      fields: { status: 'verified', platform: 'darwin', mode },
      outcomes: [
        'deniedByDefault',
        'firstBarRead',
        'selectionsDelivered',
        'replacementRevokes',
        'clearRemoves',
        'shutdownRevokes',
      ],
    })),
    packages: ['app-menu'],
  },
  {
    capabilities: ['task_dialogs_v1'],
    oracle: 'Accessibility NSAlert sheet oracle (macos-alert-oracle.m)',
    reports: [
      {
        path: 'alert-sheets/task-dialogs.json',
        fields: { platform: 'darwin', failed: false },
        outcomes: [
          'shownTextAndButtons',
          'buttonChosen',
          'escapeIsCancelButton',
          'escapeWithoutCancelButtonIgnored',
          'returnIsDefaultButton',
          'escapeIgnoredAndAbortCloses',
          'queuedInOrder',
          'confirmTrue',
          'ownerCloseEndsDialog',
          'shutdownEndsDialog',
        ],
      },
    ],
    packages: [],
  },
  {
    capabilities: ['context_menus_v1'],
    oracle: 'Accessibility NSMenu oracle (macos-context-menu-oracle.m)',
    reports: [
      {
        path: 'context-menus/context-menus.json',
        fields: { platform: 'darwin', failed: false },
        outcomes: [
          'shownItems',
          'itemChosen',
          'nestedChosen',
          'escapeDismisses',
          'abortCloses',
          'ownerCloseEndsMenu',
          'shutdownEndsMenu',
        ],
      },
    ],
    packages: [],
  },
  {
    capabilities: ['display_details_v1'],
    oracle: 'NSScreen/CoreGraphics display oracle (macos-display-oracle.m), JXA NSScreen',
    reports: perMode((mode) => ({
      path: `display-platform-${mode}/display-platform.json`,
      fields: { platform: 'darwin', mode },
      outcomes: ['osDisplays', 'denied', 'snapshot', 'revocation', 'shutdown'],
    })),
    packages: ['display-platform'],
  },
  {
    capabilities: ['display_identity_v1', 'display_changes_v1'],
    oracle:
      'NSScreen and CoreGraphics display oracle (macos-display-oracle.m: CGDisplayCreateUUIDFromDisplayID, CGConfigureDisplayWithDisplayMode), JXA NSScreen, a CGVirtualDisplay second display and Accessibility window moves (macos-virtual-display.m)',
    reports: [
      // The real display-mode change must have been applied, not recorded unavailable.
      ...perMode((mode) => ({
        path: `display-platform-${mode}/display-platform.json`,
        fields: { platform: 'darwin', mode, 'unavailable.displayChange': undefined },
        outcomes: ['snapshot', 'displayChange', 'revocation', 'shutdown'],
      })),
      ...perMode((mode) => ({
        path: `display-virtual-macos-${mode}/display-virtual-macos.json`,
        fields: { platform: 'darwin', mode },
        outcomes: ['osDisplays', 'connected', 'migration', 'removed', 'revocation', 'shutdown'],
      })),
    ],
    packages: ['display-platform', 'display-virtual-macos'],
  },
  {
    capabilities: ['filesystem_grants_v1'],
    oracle: 'node:fs on a private temporary tree',
    reports: perMode((mode) => ({
      path: `filesystem-grants-${mode}/filesystem-grants.json`,
      fields: { platform: 'darwin', backend: 'openat_walk', mode },
    })),
    packages: ['filesystem-grants'],
  },
  {
    capabilities: ['processes_v1'],
    oracle: 'real /bin/sh children; process groups through ps',
    reports: perMode((mode) => ({
      path: `processes-${mode}/processes.json`,
      fields: { backend: 'posix', mode },
    })),
    packages: ['processes'],
  },
  {
    capabilities: ['drag_drop_files_v1'],
    oracle: 'an independent AppKit NSDraggingSession source process (macos-drag-source.m)',
    reports: MODES.flatMap((mode) => [
      {
        path: `drag-drop-${mode}/drag-drop.json`,
        fields: { platform: 'darwin', backend: 'appkit', mode },
      },
      {
        path: `solid-drag-drop-${mode}/solid-drag-drop.json`,
        fields: { status: 'passed', backend: 'appkit', mode },
      },
      {
        path: `react-drag-drop-${mode}/react-drag-drop.json`,
        fields: { status: 'passed', backend: 'appkit', mode },
      },
    ]),
    packages: ['drag-drop', 'solid-drag-drop', 'react-drag-drop'],
  },
  {
    capabilities: ['clipboard_text_v1'],
    shard: 1,
    oracle: 'pbcopy, pbpaste and an osascript pasteboard clear',
    reports: [
      service('clipboard-macos/clipboard-macos.json', [
        'defaultDenial',
        'writeSeenByPbpaste',
        'readPbcopyText',
        'clearedReadsEmpty',
        'boundedRead',
        'abortBeforeDispatch',
        'staleOwnerRejected',
        'shutdownClean',
      ]),
    ],
    packages: [],
  },
  {
    capabilities: ['global_shortcuts_v1'],
    shard: 1,
    oracle:
      'Carbon Event Manager registrations and CGEventPost key presses (macos-hot-key-oracle.m)',
    reports: [
      service('global-shortcuts-macos/global-shortcuts-macos.json', [
        'defaultDenial',
        'deliveredWhileOtherAppFrontmost',
        'inSessionDuplicateConflict',
        'externalConflictMapped',
        'unregisterReleases',
        'ownerCloseReleases',
        'shutdownReleases',
      ]),
    ],
    packages: [],
  },
  {
    capabilities: ['file_dialogs_v1'],
    shard: 1,
    oracle: 'Accessibility open and save panel sheet oracle (macos-file-panel-oracle.m)',
    reports: [
      service('file-dialogs-macos/file-dialogs-macos.json', [
        'defaultDenial',
        'openCancelled',
        'folderSelected',
        'saveSelected',
        'unsupportedFilterRefused',
        'abortClosesSheet',
        'ownerCloseEndsSheet',
        'shutdownEndsSheet',
        'ownershipReleased',
      ]),
    ],
    packages: [],
  },
  {
    capabilities: ['popup_windows_v1'],
    shard: 1,
    oracle:
      'WindowServer window list, Accessibility window moves and Quartz input (macos-popup-oracle.m), host paint evidence',
    reports: [
      service('popups-macos/popups-macos.json', [
        'placedBeyondParent',
        'popupPointer',
        'escapeDismissal',
        'followsParentMove',
        'blurDismissal',
        'clampedToDisplay',
        'closedWithParent',
        'ownershipReleased',
      ]),
    ],
    packages: [],
  },
  {
    capabilities: ['notifications_v1'],
    shard: 1,
    oracle:
      'the bare release host and the installed signed template host in BunNativeHost.app; the OS prompt answer is recorded, not chosen',
    reports: [
      service('notifications-macos/notifications-macos.json', [
        'bareHostUnavailable',
        'bundledDefaultDenial',
        'authorization',
        'bundledShutdownClean',
      ]),
    ],
    packages: [],
  },
]

/** Sources the record binds beyond each package's own inventory. */
export const EXTRA_SOURCES = [
  '.github/workflows/native-platforms.yml',
  'scripts/quality/macos-feature-evidence.ts',
  'scripts/quality/native-platform-macos.m',
  'tests/native/macos-window-input.ts',
  'tests/native/png.ts',
  'tests/native/macos-accessibility-oracle.m',
  'tests/native/macos-menu-oracle.m',
  'tests/native/macos-alert-oracle.m',
  'tests/native/macos-context-menu-oracle.m',
  'tests/native/macos-display-oracle.m',
  'tests/native/macos-virtual-display.m',
  'tests/native/macos-drag-source.m',
  'tests/native/layout-style-compare.ts',
  'tests/native/task-dialogs.ts',
  'tests/native/context-menus.ts',
  'tests/native/clipboard-macos.ts',
  'tests/native/global-shortcuts-macos.ts',
  'tests/native/macos-hot-key-oracle.m',
  'tests/native/file-dialogs-macos.ts',
  'tests/native/macos-file-panel-oracle.m',
  'tests/native/popups-macos.ts',
  'tests/native/macos-popup-oracle.m',
  'tests/native/notifications-macos.ts',
  'scripts/quality/signed-installer-smoke.ts',
]

type Manifest = {
  application: { file: string; bytes: number; sha256: string }
  host: { sha256: string; profile: string }
  source: { commit: string; files: { path: string; bytes: number; sha256: string }[] }
}

export function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function at(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
      value
    )
}

export type Inputs = {
  evidence: string
  source: string
  host: string
  commit: string
  tree: string
  dirty: string[]
  run: Record<string, string | undefined>
  /** Check only this shard's features; every feature when omitted. */
  shard?: 1 | 2
}

/** Build the record; `failures` lists every unmet requirement. */
export function buildRecord(inputs: Inputs) {
  const failures: string[] = []
  const hostSha = existsSync(inputs.host) ? sha256(inputs.host) : undefined
  if (!hostSha) failures.push(`release host ${inputs.host} is missing`)
  const sources = new Map<string, string>()
  const hashSource = (path: string) => {
    if (sources.has(path)) return sources.get(path)
    const full = join(inputs.source, path)
    const value = existsSync(full) ? sha256(full) : 'missing'
    sources.set(path, value)
    return value
  }
  for (const path of EXTRA_SOURCES)
    if (hashSource(path) === 'missing') failures.push(`source ${path} is missing`)

  const packages: Record<string, unknown> = {}
  const checkPackage = (entry: string) => {
    if (entry in packages) return
    const file = join(inputs.evidence, `${entry}-package`, 'manifest.json')
    if (!existsSync(file)) {
      failures.push(`${entry}: AOT manifest is missing`)
      packages[entry] = null
      return
    }
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest
    const mismatched = manifest.source.files
      .filter((record) => hashSource(record.path) !== record.sha256)
      .map((record) => record.path)
    if (manifest.source.commit !== inputs.commit)
      failures.push(`${entry}: AOT source commit ${manifest.source.commit} is not ${inputs.commit}`)
    if (mismatched.length)
      failures.push(`${entry}: AOT sources differ from the checkout: ${mismatched.join(', ')}`)
    if (manifest.host.sha256 !== hostSha || manifest.host.profile !== 'release')
      failures.push(`${entry}: AOT package names another host or profile`)
    const application = join(inputs.evidence, `${entry}-package`, manifest.application.file)
    const applicationSha = existsSync(application) ? sha256(application) : undefined
    if (applicationSha !== manifest.application.sha256)
      failures.push(`${entry}: the AOT application differs from its manifest`)
    packages[entry] = {
      manifestSha256: sha256(file),
      application: manifest.application,
      sources: manifest.source.files.length,
    }
  }

  const selected = FEATURES.filter(
    (feature) => inputs.shard === undefined || (feature.shard ?? 2) === inputs.shard
  )
  const features = selected.map((feature) => {
    for (const entry of feature.packages) checkPackage(entry)
    const reports = feature.reports.map((report) => {
      const file = join(inputs.evidence, report.path)
      if (!existsSync(file)) {
        failures.push(`${report.path}: missing`)
        return { path: report.path, status: 'missing' }
      }
      let json: unknown
      try {
        json = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        failures.push(`${report.path}: not JSON`)
        return { path: report.path, status: 'unreadable' }
      }
      const wrong = Object.entries(report.fields)
        .filter(([key, expected]) => at(json, key) !== expected)
        .map(
          ([key, expected]) =>
            `${key}=${JSON.stringify(at(json, key))} (want ${JSON.stringify(expected)})`
        )
      const outcomes = at(json, 'outcomes')
      const absent = (report.outcomes ?? []).filter(
        (name) => !outcomes || typeof outcomes !== 'object' || !(name in outcomes)
      )
      if (wrong.length) failures.push(`${report.path}: ${wrong.join('; ')}`)
      if (absent.length) failures.push(`${report.path}: outcomes missing ${absent.join(', ')}`)
      return {
        path: report.path,
        status: wrong.length || absent.length ? 'failed' : 'passed',
        bytes: statSync(file).size,
        sha256: sha256(file),
        fields: report.fields,
        ...(report.outcomes ? { outcomes: report.outcomes } : {}),
      }
    })
    return {
      capabilities: feature.capabilities,
      oracle: feature.oracle,
      status: reports.every((report) => report.status === 'passed') ? 'passed' : 'failed',
      reports,
      packages: feature.packages,
    }
  })

  const record = {
    schemaVersion: 1,
    status: failures.length ? 'failed' : 'passed',
    shard: inputs.shard ?? 'all',
    scope:
      'Hosted macOS feature qualification in development and inspected AOT against one release GPUI host (for notifications also its signed copy installed from the template image). Each report comes from a gating step with a real native window and an independent macOS oracle; hosted VM, software-presented display and synthesized CoreGraphics input, not physical hardware.',
    run: inputs.run,
    source: {
      commit: inputs.commit,
      tree: inputs.tree,
      dirty: inputs.dirty.length > 0,
      changes: inputs.dirty,
      filesSha256: Object.fromEntries([...sources].sort(([a], [b]) => a.localeCompare(b))),
    },
    host: hostSha ? { sha256: hostSha, bytes: statSync(inputs.host).size } : null,
    packages,
    features,
    failures,
  }
  return record
}

function git(source: string, args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: source, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.toString().trim()
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      evidence: { type: 'string' },
      source: { type: 'string' },
      host: { type: 'string' },
      output: { type: 'string' },
      shard: { type: 'string' },
    },
    strict: true,
  })
  const { evidence, source, host, output } = values
  const shard = values.shard === '1' ? 1 : values.shard === '2' ? 2 : undefined
  if (
    process.platform !== 'darwin' ||
    shard === undefined ||
    !evidence ||
    !isAbsolute(evidence) ||
    !source ||
    !isAbsolute(source) ||
    !host ||
    !isAbsolute(host) ||
    !output ||
    !isAbsolute(output)
  )
    throw new Error(
      'Usage on macOS: bun scripts/quality/macos-feature-evidence.ts --evidence DIR --source CHECKOUT --host HOST --output FILE (all absolute) --shard 1|2'
    )
  const env = process.env
  const record = buildRecord({
    shard,
    evidence,
    source,
    host,
    commit: git(source, ['rev-parse', 'HEAD']),
    tree: git(source, ['rev-parse', 'HEAD^{tree}']),
    dirty: git(source, ['status', '--porcelain']).split('\n').filter(Boolean),
    run: {
      repository: env['GITHUB_REPOSITORY'],
      runId: env['GITHUB_RUN_ID'],
      runAttempt: env['GITHUB_RUN_ATTEMPT'],
      job: env['GITHUB_JOB'],
      eventName: env['GITHUB_EVENT_NAME'],
      ref: env['GITHUB_REF'],
      sha: env['GITHUB_SHA'],
      imageOS: env['ImageOS'],
      imageVersion: env['ImageVersion'],
    },
  })
  writeFileSync(output, JSON.stringify(record, null, 2) + '\n')
  for (const feature of record.features)
    console.log(`${feature.status}: ${feature.capabilities.join(', ')}`)
  if (record.failures.length) {
    for (const failure of record.failures) console.error(failure)
    process.exit(1)
  }
}
