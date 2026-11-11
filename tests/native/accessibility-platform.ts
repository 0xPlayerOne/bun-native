/**
 * Real macOS (NSAccessibility) and Windows (UI Automation) accessibility
 * qualification (#241), in the hosted runner's GUI session.
 *
 * The tree is read and operated only by an independent platform client that
 * never links GPUI: tests/native/macos-accessibility-oracle.m (AXUIElement, the
 * API VoiceOver uses) or tests/native/windows-accessibility-oracle.ps1 (UI
 * Automation, the API Narrator uses). No pointer or key input is synthesized:
 * every change below comes from an assistive-technology request, and every
 * effect is read from public Bun events and from the platform tree again.
 */
import {
  createApplication,
  onSplitResize,
  type NativeNode,
  type SplitResizeEvent,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_A11Y_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_A11Y_MODE']
const oracle = process.env['BUN_NATIVE_A11Y_ORACLE']
const platform = process.platform
if (
  (platform !== 'darwin' && platform !== 'win32') ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !oracle ||
  !isAbsolute(oracle)
)
  throw new Error(
    'macOS or Windows, an evidence directory, the host, the mode and the platform oracle are required'
  )
const host = executable
const client = oracle
const mac = platform === 'darwin'

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const dumps: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeout = 5_000,
  observed?: () => string
) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until)
      throw new Error(
        'Timed out waiting for ' + description + (observed ? '; observed ' + observed() : '')
      )
    await Bun.sleep(25)
  }
}

/** The platform node, normalized to the AT-SPI role vocabulary of the Linux fixture. */
type Node = {
  role: string
  name: string
  value: string | number | null
  enabled: boolean | null
  focused: boolean | null
  settable: boolean | null
  minimum: number | null
  maximum: number | null
  selection: number[] | null
  depth: number
  raw: Record<string, unknown>
}

const MAC_ROLES: Record<string, string> = {
  AXStaticText: 'label',
  AXButton: 'push-button',
  AXTextField: 'entry',
  AXSplitter: 'separator',
  AXUnknown: 'panel',
  AXWindow: 'dialog',
}
const WINDOWS_ROLES: Record<string, string> = {
  Text: 'label',
  Button: 'push-button',
  Edit: 'entry',
  Separator: 'separator',
  Pane: 'panel',
  Window: 'dialog',
}
const PLATFORM_ROLE = Object.fromEntries(
  Object.entries(mac ? MAC_ROLES : WINDOWS_ROLES).map(([native, role]) => [role, native])
)

const flag = (value: unknown) =>
  typeof value === 'boolean' ? value : value === null ? null : !!value
const numeric = (value: unknown) => (typeof value === 'number' ? value : null)

function normalize(entry: Record<string, unknown>): Node {
  if (mac) {
    const title = String(entry['title'] ?? '')
    const description = String(entry['description'] ?? '')
    const value = entry['value'] as string | number | null
    const role = MAC_ROLES[String(entry['role'])] ?? String(entry['role'])
    return {
      role,
      // Buttons carry a title, labels a value and named containers a description.
      name: title || description || (role === 'label' && typeof value === 'string' ? value : ''),
      value,
      enabled: flag(entry['enabled']),
      focused: flag(entry['focused']),
      settable: flag(entry['valueSettable']),
      minimum: numeric(entry['minimum']),
      maximum: numeric(entry['maximum']),
      selection: (entry['selection'] as number[] | null) ?? null,
      depth: Number(entry['depth']),
      raw: entry,
    }
  }
  const role = WINDOWS_ROLES[String(entry['role'])] ?? String(entry['role'])
  const readOnly = entry['readOnly']
  return {
    role,
    name: String(entry['name'] ?? ''),
    value: (entry['value'] as string | number | null) ?? null,
    enabled: flag(entry['enabled']),
    focused: flag(entry['focused']),
    settable: typeof readOnly === 'boolean' ? !readOnly : null,
    minimum: numeric(entry['minimum']),
    maximum: numeric(entry['maximum']),
    selection: null,
    depth: Number(entry['depth']),
    raw: entry,
  }
}

const oracleCommand = (args: string[]) =>
  mac
    ? [client, ...args]
    : [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        client,
        ...args,
      ]

/** The host is this process's direct child; its executable is the host path. */
async function hostPid(): Promise<string> {
  const children = (await run(['pgrep', '-P', String(process.pid)])).stdout.split('\n')
  for (const child of children.filter(Boolean)) {
    const command = (await run(['ps', '-o', 'comm=', '-p', child])).stdout
    if (command === host || command.endsWith('/bun-native-host')) return child
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

const TITLE = 'Bun Native platform accessibility qualification'
const MIN_PANE = 100
const DIVIDER = 6
const SPLIT_WIDTH = 600
const PANES = SPLIT_WIDTH - DIVIDER
const near = (actual: unknown, expected: number, label: string, tolerance = 1e-3) =>
  assert(
    typeof actual === 'number' && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not ${expected}`
  )

if (mac) {
  const trust = await run([client, 'trusted'])
  assert.equal(trust.code, 0, trust.stderr)
  assert.equal(
    (JSON.parse(trust.stdout) as { trusted: boolean }).trusted,
    true,
    'the runner trusts the oracle for Accessibility'
  )
}

const app = await createApplication({ executable: host })
assert(app.capabilities.includes('accessibility_v1' as never), 'accessibility_v1')
const searchValues: string[] = []
const readOnlyValues: string[] = []
const focusTrace: string[] = []
const resizes: SplitResizeEvent[] = []
let actionClicks = 0
try {
  const window = await app.openWindow({ title: TITLE, width: 640, height: 420 })
  const nodes = await window.batch((batch) => {
    batch.set(window.root, { kind: 'box', style: { direction: 'column', background: 0xffffff } })
    const add = <N extends NativeNode>(
      parent: NativeNode<'box' | 'split' | 'overlay'>,
      node: N
    ) => {
      batch.append(parent, node)
      return node
    }
    add(
      window.root,
      batch.create({ kind: 'text', text: 'Accessibility qualification', style: { height: 28 } })
    )
    const list = add(
      window.root,
      batch.create({ kind: 'box', style: { overflow: 'scroll_y', height: 60 } })
    )
    add(list, batch.create({ kind: 'text', text: 'Item 1' }))
    const split = add(
      window.root,
      batch.create({
        kind: 'split',
        ratio: 0.4,
        min_size: MIN_PANE,
        accessible_label: 'Sidebar',
        style: { width: SPLIT_WIDTH, height: 180, flex_shrink: 0 },
      })
    )
    const leading = add(split, batch.create({ kind: 'box', style: { width: 'fill' } }))
    const action = add(leading, batch.create({ kind: 'button', text: 'Leading action' }))
    const trailing = add(split, batch.create({ kind: 'box', style: { width: 'fill' } }))
    const search = add(
      trailing,
      batch.create({ kind: 'input', value: 'typed', placeholder: 'Search', style: { height: 40 } })
    )
    const fixed = add(
      trailing,
      batch.create({ kind: 'input', value: 'Fixed', read_only: true, style: { height: 40 } })
    )
    add(trailing, batch.create({ kind: 'button', text: 'Disabled action', disabled: true }))
    const open = add(
      window.root,
      batch.create({ kind: 'button', text: 'Open dialog', style: { height: 40 } })
    )
    return { split, action, search, fixed, open }
  })
  window.onInput(nodes.search, (event) => void searchValues.push(event.value))
  window.onInput(nodes.fixed, (event) => void readOnlyValues.push(event.value))
  window.onClick(nodes.action, () => void (actionClicks += 1))
  for (const [node, name] of [
    [nodes.search, 'search'],
    [nodes.action, 'action'],
    [nodes.open, 'open'],
  ] as const)
    window.on(node, 'focus', (event) => {
      if (event.node === node) focusTrace.push(name)
    })
  onSplitResize(window, nodes.split, (event) => void resizes.push(event))
  let open = false
  window.onClick(nodes.open, async () => {
    const { layer, cancel } = await window.batch((batch) => {
      const layer = batch.create({
        kind: 'overlay',
        modal: true,
        accessible_label: 'Confirm dialog',
        style: { padding: 24, gap: 8, background: 0xf4f5f7 },
      })
      batch.append(window.root, layer)
      batch.append(layer, batch.create({ kind: 'text', text: 'Discard changes?' }))
      const cancel = batch.create({ kind: 'button', text: 'Cancel' })
      batch.append(layer, cancel)
      return { layer, cancel }
    })
    window.onClick(cancel, async () => {
      await window.batch((batch) => batch.remove(layer))
      open = false
    })
    open = true
  })

  const pid = mac ? await hostPid() : ''
  const target = mac ? [pid, TITLE] : [TITLE]
  const dump = async (label: string) => {
    const result = await run(oracleCommand(['dump', ...target]))
    assert.equal(result.code, 0, `${label}: ${result.stderr}`)
    const entries = JSON.parse(result.stdout || '[]') as Array<Record<string, unknown>>
    dumps[label] = entries
    return entries.map(normalize)
  }
  /** Poll the platform tree until the condition holds; AccessKit updates after a frame. */
  const poll = async (label: string, check: (tree: Node[]) => boolean, timeout = 10_000) => {
    const until = performance.now() + timeout
    for (;;) {
      const tree = await dump(label)
      if (check(tree)) return tree
      if (performance.now() > until)
        throw new Error(
          `Timed out waiting for ${label}: ${JSON.stringify(tree.map(({ role, name, value }) => ({ role, name, value })))}`
        )
      await Bun.sleep(100)
    }
  }
  const act = async (role: string, name: string, action: string, ...args: string[]) => {
    const native = PLATFORM_ROLE[role]!
    const verb = mac ? action : action === 'press' ? 'invoke' : action
    return run(oracleCommand(['act', ...target, native, name, verb, ...args]))
  }
  const must = async (role: string, name: string, action: string, ...args: string[]) => {
    const result = await act(role, name, action, ...args)
    assert.equal(result.code, 0, `${action} on ${role} ${name}: ${result.stderr}`)
  }
  const find = (tree: Node[], role: string, name: string) =>
    tree.find((node) => node.role === role && (node.name === name || node.value === name))
  /**
   * macOS: poll the application's AXFocusedUIElement, the attribute VoiceOver
   * follows, until it is the text field with this value in this window.
   */
  const focusedField = async (label: string, window: string, value: string) => {
    const until = performance.now() + 10_000
    for (;;) {
      const result = await run([client, 'focused', String(pid)])
      assert.equal(result.code, 0, `${label}: ${result.stderr}`)
      const focused = JSON.parse(result.stdout) as {
        active: boolean
        window: string | null
        element: { role: string; value: unknown } | null
      }
      if (
        focused.window === window &&
        focused.element?.role === 'AXTextField' &&
        focused.element.value === value
      )
        return focused
      if (performance.now() > until)
        throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(focused)}`)
      await Bun.sleep(100)
    }
  }

  // Every element kind's platform node, before any request.
  const initial = await poll(
    'initial',
    (tree) =>
      find(tree, 'separator', 'Sidebar') !== undefined && find(tree, 'entry', 'typed') !== undefined
  )
  assert(find(initial, 'label', 'Accessibility qualification'), 'text is a named static text')
  assert(find(initial, 'label', 'Item 1'), 'scrolled content is exposed')
  const action = find(initial, 'push-button', 'Leading action')
  assert(action && action.enabled !== false, 'an enabled button')
  assert(find(initial, 'push-button', 'Disabled action'), 'the disabled button is exposed by name')
  const search = find(initial, 'entry', 'typed')!
  assert.equal(search.settable, true, 'an editable entry accepts a value')
  const fixed = find(initial, 'entry', 'Fixed')
  assert(fixed, 'the read-only entry is exposed')
  // UIA reports a read-only ValuePattern. AccessKit 0.24's macOS adapter still
  // reports AXValue settable on a read-only text field (measured on hosted
  // macos-15); the host rejects the request below on both platforms.
  if (!mac) assert.equal(fixed.settable, false, 'a read-only entry does not accept a value')
  const divider = find(initial, 'separator', 'Sidebar')!
  near(divider.value, 40, 'divider value is the ratio in percent')
  near(divider.minimum, (MIN_PANE / PANES) * 100, 'divider minimum from min_size')
  near(divider.maximum, (1 - MIN_PANE / PANES) * 100, 'divider maximum from min_size')
  assert(!initial.some((node) => node.role === 'dialog'), 'no dialog before it opens')
  if (mac) {
    record('initialFocusedElement', await focusedField('initial focused element', TITLE, 'typed'))
    // The element at the field's centre is the field, as VoiceOver's pointer
    // exploration finds it; GPUI's view, not AccessKit's, lies under the point.
    const hit = await run(oracleCommand(['act', ...target, 'AXTextField', 'typed', 'hit']))
    assert.equal(hit.code, 0, `hit test: ${hit.stderr}`)
    const element = JSON.parse(hit.stdout) as { role: string; value: unknown }
    assert.equal(element.role, 'AXTextField', `hit test: ${hit.stdout}`)
    assert.equal(element.value, 'typed', `hit test: ${hit.stdout}`)
    record('hitTestElement', element)
  }
  record('initialTree', {
    roles: [...new Set(initial.map((node) => node.role))].sort(),
    nodes: initial.length,
    disabledButtonEnabled: find(initial, 'push-button', 'Disabled action')!.enabled,
    readOnlyEntrySettable: fixed.settable,
  })

  // Text: the platform sets the whole value; the host applies it through the
  // ordinary edit path and reports one input event.
  await must('entry', 'typed', 'text', 'hello')
  await waitFor(
    () => searchValues.at(-1) === 'hello',
    'AT value',
    5_000,
    () => searchValues.join()
  )
  await poll('value set', (tree) => find(tree, 'entry', 'hello') !== undefined)
  // A read-only entry rejects the same request without an input event.
  const rejected = await act('entry', 'Fixed', 'text', 'changed')
  await Bun.sleep(300)
  assert.deepEqual(readOnlyValues, [], 'a read-only input reports no edit')
  assert(find(await dump('read-only'), 'entry', 'Fixed'), 'the read-only value is unchanged')
  const textOutcome: Record<string, unknown> = {
    values: searchValues.slice(),
    readOnlyRequest: { code: rejected.code, stderr: rejected.stderr.slice(0, 300) },
  }
  if (mac) {
    // A selection request moves the host's selection, which the tree reports back.
    await must('entry', 'hello', 'select', '1', '3')
    const selected = await poll(
      'selection set',
      (tree) => JSON.stringify(find(tree, 'entry', 'hello')?.selection) === '[1,3]'
    )
    textOutcome['selection'] = find(selected, 'entry', 'hello')?.selection
  }
  record('assistiveText', textOutcome)

  // Buttons: the platform's press is a click; focus requests focus.
  await must('push-button', 'Leading action', 'press')
  await waitFor(
    () => actionClicks === 1,
    'AT press',
    5_000,
    () => focusTrace.join()
  )
  await must('entry', 'hello', 'focus')
  await waitFor(
    () => focusTrace.at(-1) === 'search',
    'AT focus',
    5_000,
    () => focusTrace.join()
  )
  await poll('focused', (tree) => find(tree, 'entry', 'hello')?.focused === true)
  record('assistiveControls', { clicks: actionClicks, focus: focusTrace.slice() })

  // The divider: a numeric value request, clamped to min_size, and on macOS
  // AXIncrement; each is one keyboard-sourced split_resize. AccessKit 0.24's
  // UIA adapter reports every Splitter's RangeValue as read-only (the role is
  // not in its read-only-supported set), so a UI Automation client refuses to
  // set it; that limit is recorded, not worked around.
  let dividerOutcome: Record<string, unknown> = {}
  if (mac) {
    await must('separator', 'Sidebar', 'number', '30')
    await waitFor(() => resizes.length === 1, 'AT divider value')
    near(resizes[0]!.ratio, 0.3, 'AT-set ratio', 1e-9)
    assert.equal(resizes[0]!.source, 'keyboard')
    await poll('divider set', (tree) => {
      const value = find(tree, 'separator', 'Sidebar')?.value
      return typeof value === 'number' && Math.abs(value - 30) < 1e-6
    })
    await must('separator', 'Sidebar', 'number', '1')
    await waitFor(() => resizes.length === 2, 'clamped AT divider value')
    near(resizes[1]!.ratio, MIN_PANE / PANES, 'AT value clamps to min_size', 1e-9)
    await must('separator', 'Sidebar', 'increment')
    await waitFor(() => resizes.length === 3, 'AXIncrement')
    near(
      resizes[2]!.ratio,
      Math.round((MIN_PANE / PANES + 0.01) * 10_000) / 10_000,
      'one step',
      1e-9
    )
  } else {
    assert.equal(divider.settable, false, 'UIA reports the divider RangeValue read-only')
    const refused = await act('separator', 'Sidebar', 'number', '30')
    assert.notEqual(refused.code, 0, 'the UIA client refuses a read-only RangeValue')
    await Bun.sleep(300)
    assert.equal(resizes.length, 0, 'no resize without a request reaching the host')
    dividerOutcome = { rangeValueReadOnly: true, refusal: refused.stderr.slice(0, 200) }
  }
  record('assistiveDivider', {
    ...dividerOutcome,
    resizes: resizes.map(({ ratio, source }) => ({ ratio, source })),
  })

  // A modal dialog opened by an AT press: the platform sees it named and
  // nothing beneath it; closing it brings the content back.
  await must('push-button', 'Open dialog', 'press')
  await waitFor(() => open, 'dialog opened')
  const opened = await poll('dialog', (tree) => find(tree, 'push-button', 'Cancel') !== undefined)
  const dialogNode = opened.find((node) => node.role === 'dialog' && node.name === 'Confirm dialog')
  for (const [role, name] of [
    ['label', 'Accessibility qualification'],
    ['label', 'Item 1'],
    ['push-button', 'Leading action'],
    ['separator', 'Sidebar'],
    ['entry', 'hello'],
    ['push-button', 'Open dialog'],
  ] as const)
    assert(!find(opened, role, name), `${role} ${name} is hidden beneath the modal dialog`)
  assert(find(opened, 'label', 'Discard changes?'), 'dialog content is exposed')
  await must('push-button', 'Cancel', 'press')
  await waitFor(() => !open, 'dialog closed')
  const closed = await poll(
    'closed',
    (tree) =>
      find(tree, 'separator', 'Sidebar') !== undefined && !find(tree, 'push-button', 'Cancel')
  )
  assert(find(closed, 'entry', 'hello'), 'content beneath returns after the dialog closes')
  record('modalDialog', {
    dialogNode: dialogNode ? { role: dialogNode.role, raw: dialogNode.raw } : null,
    exposed: opened.map(({ role, name }) => role + ':' + name),
  })

  // macOS: a second window opened while the application is already active
  // becomes key while GPUI constructs it, before GPUI creates the window's
  // AccessKit adapter, which starts out believing the window is unfocused.
  // The host repeats the key notification once the adapter exists
  // (native/macos-surface/src/key_status.rs); without that, the application
  // reports no focused element and VoiceOver follows no focus in the window.
  if (mac) {
    const SECOND = TITLE + ' second window'
    const second = await app.openWindow({ title: SECOND, width: 360, height: 160 })
    await second.batch((batch) => {
      batch.set(second.root, { kind: 'box', style: { direction: 'column', background: 0xffffff } })
      batch.append(
        second.root,
        batch.create({ kind: 'input', value: 'second', style: { height: 40 } })
      )
    })
    const focused = await focusedField('second window focused element', SECOND, 'second')
    assert.equal(focused.active, true, 'the application is active')
    record('secondWindowFocusedElement', focused)
    await second.close()
  }

  await window.close()
} finally {
  writeFileSync(join(output, 'platform-trees.json'), JSON.stringify(dumps, null, 2) + '\n')
  await app.shutdown()
  await app.closed
}
assert(Object.values(app.diagnostics).every((count) => count === 0))
const result = {
  status: 'passed',
  scenario: 'accessibility-platform',
  platform,
  client: mac
    ? 'AXUIElement (macos-accessibility-oracle.m)'
    : 'UI Automation (windows-accessibility-oracle.ps1)',
  mode,
  elapsedMs: Math.round(performance.now() - started),
  outcomes,
}
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ status: 'passed', platform, mode }))
