import assert from 'node:assert/strict'
;(
  globalThis as typeof globalThis & { __bunlyTerminalLoadProfile?: unknown }
).__bunlyTerminalLoadProfile = 'windowed'
const { fixture, raw } = await import('../helpers/terminal-load-rows.ts')
const { acceptLoadRows } = await import('../../benchmarks/lib/terminal-load-acceptance.ts')
const { LOAD } = await import('../../examples/cef-terminal-load/workload.ts')
const { expectedVisibility } = await import('../../examples/cef-terminal-load/mode-state.ts')
const foreground = {
  visible: true,
  active: true,
  minimized: false,
  maximized: false,
  fullscreen: false,
}
for (const selected of LOAD.modes) {
  const rows = fixture(),
    visibility = expectedVisibility(selected)
  const nativeState = {
    ...foreground,
    active: selected === 'foreground',
    visible: selected !== 'hidden',
    minimized: selected === 'minimized',
  }
  const observed = { mode: selected, nativeState, visibility }
  rows[0]!['schema'] = 2
  rows[0]!['mode'] = selected
  rows[0]!['visibilityReceipts'] =
    visibility === 'visible' ? ['initial-visible'] : ['initial-visible', 'hidden']
  rows[0]!['windowMode'] = {
    initial: { mode: 'visible', nativeState: foreground, visibility: 'visible' },
    admitted: observed,
  }
  rows[0]!['terminalOwnership'] = 'native-non-detaching'
  rows.at(-1)!['terminalOwnership'] = 'native-non-detaching'
  rows.at(-1)!['windowMode'] = {
    loaded: observed,
    restored: { mode: 'foreground', nativeState: foreground, visibility: 'visible' },
  }
  for (const row of rows) {
    if (row['kind'] === 'batch') row['visibility'] = visibility
    if (row['kind'] === 'phase') row['windowMode'] = observed
  }
  acceptLoadRows(raw(rows), selected, 'Darwin', 'cef', 'native-non-detaching')
  for (const mutate of [
    (value: Record<string, unknown>[]) => {
      delete value[0]!['windowMode']
    },
    (value: Record<string, unknown>[]) => {
      value[0]!['schema'] = 1
    },
    (value: Record<string, unknown>[]) => {
      delete value.find((row) => row['kind'] === 'phase')!['windowMode']
    },
    (value: Record<string, unknown>[]) => {
      value[0]!['windowMode'] = {
        initial: { mode: 'visible', nativeState: foreground, visibility: 'visible' },
        admitted: { ...observed, visibility: visibility === 'visible' ? 'hidden' : 'visible' },
      }
    },
    (value: Record<string, unknown>[]) => {
      value.at(-1)!['windowMode'] = {
        loaded: observed,
        restored: {
          mode: 'foreground',
          nativeState: { ...foreground, active: false },
          visibility: 'visible',
        },
      }
    },
    (value: Record<string, unknown>[]) => {
      value[1]!['visibility'] = visibility === 'visible' ? 'hidden' : 'visible'
    },
  ]) {
    const changed = structuredClone(rows)
    mutate(changed)
    assert.throws(() =>
      acceptLoadRows(raw(changed), selected, 'Darwin', 'cef', 'native-non-detaching')
    )
  }
}
console.log(JSON.stringify({ passed: true, modes: LOAD.modes, legacyNotRelabeled: true }))
