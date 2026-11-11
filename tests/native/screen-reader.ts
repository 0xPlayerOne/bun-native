/**
 * Real screen-reader speech qualification (#241).
 *
 * A real screen reader runs against the GPUI host while real OS key input
 * moves keyboard focus, edits an input and opens a modal dialog. What the
 * screen reader decided to say is captured where it leaves the screen reader:
 *
 * - Linux X11: Orca, started inside the isolated Xvfb + AT-SPI session, speaks
 *   through a private speech-dispatcher whose only output module is
 *   `sd_generic` writing each utterance to a file instead of a sound card.
 *   Keys come from XTEST (xdotool).
 * - macOS: VoiceOver, controlled through its AppleScript interface (`content
 *   of last phrase`, polled). Keys come from CGEventPost in
 *   tests/native/macos-input-oracle.m. The runner must have been prepared by
 *   scripts/quality/macos-voiceover-setup.sh. After every focus change the
 *   independent AX client tests/native/macos-accessibility-oracle.m also reads
 *   the host's AXFocusedUIElement, the attribute VoiceOver follows, so a
 *   missing phrase is attributed either to the host's accessibility exposure
 *   or to VoiceOver.
 * - Windows: a portable NVDA with the silence synthesizer, logging every
 *   speech sequence it sends at the input/output log level. Keys come from
 *   SendInput in tests/native/windows-input-oracle.ps1.
 *
 * Every focus change is also read from public Bun focus events, so a phrase is
 * only accepted after the host actually moved focus. Linux asserts Orca's exact
 * phrases; macOS and Windows assert the control name and role word and record
 * every phrase verbatim.
 */
import { createApplication, onSplitResize, type NativeNode } from '@bun-native/core'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { nvdaSpeech } from './screen-reader-speech.ts'

const output = process.env['BUN_NATIVE_SR_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_SR_MODE']
const platform = process.platform
const linux = platform === 'linux'
// Linux on Wayland: the owned headless sway session
// (scripts/quality/native-wayland-session.sh); keys come from wtype.
const wayland = linux && Boolean(process.env['WAYLAND_DISPLAY'])
const mac = platform === 'darwin'
// Linux: a system Python with PyGObject that runs Orca. macOS: the compiled
// macos-input-oracle. Windows: the absolute path of windows-input-oracle.ps1.
const driver = linux ? process.env['BUN_NATIVE_ATSPI_PYTHON'] : process.env['BUN_NATIVE_SR_INPUT']
const nvda = process.env['BUN_NATIVE_NVDA']
// macOS: the compiled macos-accessibility-oracle.
const axOracle = process.env['BUN_NATIVE_A11Y_ORACLE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !driver ||
  !isAbsolute(driver) ||
  (linux &&
    (wayland ? !process.env['SWAYSOCK'] || process.env['DISPLAY'] : !process.env['DISPLAY'])) ||
  (platform === 'win32' && (!nvda || !isAbsolute(nvda))) ||
  (platform === 'darwin' && (!axOracle || !isAbsolute(axOracle)))
)
  throw new Error(
    'An evidence directory, the host, the mode, the platform input driver (Linux: the AT-SPI Python), on Windows NVDA and on macOS the AX oracle are required'
  )
const host = executable
const evidence = output

const TITLE = 'Bun Native screen reader qualification'
const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 10_000,
  observed?: () => string
) {
  const until = performance.now() + timeout
  while (!(await check())) {
    if (performance.now() > until)
      throw new Error(
        'Timed out waiting for ' + description + (observed ? '; observed ' + observed() : '')
      )
    await Bun.sleep(25)
  }
}

type Key =
  | 'tab'
  | 'shift+tab'
  | 'space'
  | 'end'
  | 'home'
  | 'left'
  | 'right'
  | 'shift+end'
  | 'backspace'
  | 'x'
  | 'where-am-i'

/** One screen reader and the OS input that reaches the application. */
interface Reader {
  readonly name: string
  start(): Promise<Record<string, unknown>>
  /** Called once the application window exists, before any key. */
  attach(pid: number): Promise<void>
  press(key: Key): Promise<void>
  /** Every phrase captured so far, in order. */
  utterances(): string[]
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// Linux: Orca through a private speech-dispatcher with a file output module.

class Orca implements Reader {
  readonly name = 'Orca'
  #socketDirectory = mkdtempSync(join(tmpdir(), 'bn-sd-'))
  #capture = join(evidence, 'spoken.txt')
  #speechd: ReturnType<typeof Bun.spawn> | undefined
  #orca: ReturnType<typeof Bun.spawn> | undefined
  #xvfb: ReturnType<typeof Bun.spawn> | undefined
  #keyboard: ReturnType<typeof Bun.spawn> | undefined

  async start() {
    // The socket path lives under a short temporary directory: the evidence
    // path can exceed the 108-byte AF_UNIX limit.
    const config = join(evidence, 'speechd-config')
    mkdirSync(join(config, 'modules'), { recursive: true })
    const logs = join(evidence, 'speechd-log')
    mkdirSync(logs)
    writeFileSync(this.#capture, '')
    // sd_generic runs this shell command for every message speech-dispatcher
    // asks it to synthesize; $DATA is the text after speech-dispatcher's own
    // processing. The ALSA null device satisfies the audio initialization the
    // module requires even though it produces no sound.
    writeFileSync(
      join(config, 'speechd.conf'),
      [
        'LogLevel 4',
        `LogDir "${logs}"`,
        'AudioOutputMethod "alsa"',
        'AudioALSADevice "null"',
        'AddModule "capture" "sd_generic" "capture.conf"',
        'DefaultModule capture',
        '',
      ].join('\n')
    )
    writeFileSync(
      join(config, 'modules', 'capture.conf'),
      [
        `GenericExecuteSynth "printf '%s\\\\n' \\'$DATA\\' >> ${this.#capture}"`,
        'GenericLanguage "en" "en" "utf-8"',
        'AddVoice "en" "MALE1" "capture"',
        '',
      ].join('\n')
    )
    const socket = join(this.#socketDirectory, 'speechd.sock')
    this.#speechd = Bun.spawn(
      [
        'speech-dispatcher',
        '--run-single',
        '--timeout',
        '0',
        '--config-dir',
        config,
        '--socket-path',
        socket,
        '--pid-file',
        join(this.#socketDirectory, 'speechd.pid'),
        '--log-dir',
        logs,
        '--log-level',
        '4',
      ],
      {
        stdin: 'ignore',
        stdout: Bun.file(join(logs, 'stdout.log')),
        stderr: Bun.file(join(logs, 'stderr.log')),
      }
    )
    await waitFor(() => existsSync(socket), 'the speech-dispatcher socket')
    // The host's first launch D-Bus-activates xdg-desktop-portal, which brings
    // up xdg-desktop-portal-gtk. Activated while Orca runs, one of them
    // registered on the accessibility bus and then did not answer for about
    // 15 s, blocking Orca's single event loop (measured: Orca's
    // get_role_name on the new application timed out, after which it spoke
    // the host's window). A desktop session has its portals running before
    // any application starts, so start them first here too.
    const portals: Array<[string, string]> = [
      ['org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop'],
      ['org.freedesktop.impl.portal.desktop.gtk', '/org/freedesktop/portal/desktop'],
    ]
    for (const [destination, path] of portals)
      await run([
        'gdbus',
        'call',
        '--session',
        '--dest',
        destination,
        '--object-path',
        path,
        '--method',
        'org.freedesktop.DBus.Peer.Ping',
      ]).catch((error: Error) =>
        console.log(JSON.stringify({ portal: destination, error: error.message }))
      )
    const version = await run([driver!, '/usr/bin/orca', '--version'])
    // Orca 46.1 reads the keymap of an X display while it loads its settings
    // (orca/orca_modifier_manager.py, refresh_orca_modifiers: `xkbcomp
    // $DISPLAY`) and exits without one. GNOME and KDE Wayland sessions give it
    // XWayland's; on the X-less sway session Orca alone gets a private Xvfb.
    // The host has no DISPLAY and stays a native Wayland client.
    const orcaDisplay: Record<string, string> = {}
    if (wayland) {
      // A virtual keyboard that lasts the whole run gives the seat its
      // keyboard capability before the window exists, so the compositor can
      // give the window keyboard focus (as tests/native/wayland.ts does).
      this.#keyboard = Bun.spawn(['wtype', '-s', '3600000'], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'inherit',
      })
      await waitFor(async () => {
        const seats = JSON.parse(await run(['swaymsg', '-t', 'get_seats', '--raw'])) as {
          capabilities: number
        }[]
        return seats.length === 1 && (seats[0]!.capabilities & 2) === 2
      }, 'a seat with a lasting keyboard')
      const xvfb = Bun.spawn(['Xvfb', '-displayfd', '1', '-nolisten', 'tcp'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: Bun.file(join(evidence, 'orca-xvfb.log')),
      })
      this.#xvfb = xvfb
      const reader = xvfb.stdout.getReader()
      const { value } = await reader.read()
      reader.releaseLock()
      const number = new TextDecoder().decode(value).trim()
      assert.match(number, /^\d+$/, 'the private Xvfb display number')
      orcaDisplay['DISPLAY'] = ':' + number
    }
    const home = join(evidence, 'orca-home')
    this.#orca = Bun.spawn(
      [
        driver!,
        '/usr/bin/orca',
        '-u',
        join(evidence, 'orca-prefs'),
        '--debug-file',
        join(evidence, 'orca-debug.log'),
      ],
      {
        stdin: 'ignore',
        stdout: Bun.file(join(evidence, 'orca.log')),
        stderr: Bun.file(join(evidence, 'orca-stderr.log')),
        env: {
          ...process.env,
          ...orcaDisplay,
          SPEECHD_ADDRESS: 'unix_socket:' + socket,
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_DATA_HOME: join(home, 'data'),
          XDG_CACHE_HOME: join(home, 'cache'),
        },
      }
    )
    // Orca announces itself only after its speech server connected.
    await waitFor(
      () => this.utterances().includes('Screen reader on.'),
      'Orca to speak through speech-dispatcher',
      20_000,
      () => JSON.stringify(this.utterances())
    )
    const speechd = await run(['speech-dispatcher', '--version'])
    return { orca: version, speechDispatcher: speechd.split('\n')[0], output: 'sd_generic to file' }
  }

  async attach() {
    if (wayland) {
      const criteria = `[title="^${TITLE}$"]`
      await waitFor(
        async () => (await run(['swaymsg', criteria, 'focus']).catch(() => '')) !== '',
        'the mapped Wayland view'
      )
      return
    }
    const ids = (await run(['xdotool', 'search', '--sync', '--name', '^' + TITLE + '$'])).split(
      '\n'
    )
    assert.equal(ids.length, 1, 'exactly one owned window')
    await run(['xdotool', 'windowactivate', '--sync', ids[0]!])
  }

  async press(key: Key) {
    const keys: Record<Key, string[]> = {
      tab: ['key', '--clearmodifiers', 'Tab'],
      'shift+tab': ['key', '--clearmodifiers', 'shift+Tab'],
      space: ['key', '--clearmodifiers', 'space'],
      end: ['key', '--clearmodifiers', 'End'],
      home: ['key', '--clearmodifiers', 'Home'],
      left: ['key', '--clearmodifiers', 'Left'],
      right: ['key', '--clearmodifiers', 'Right'],
      'shift+end': ['key', '--clearmodifiers', 'shift+End'],
      backspace: ['key', '--clearmodifiers', 'BackSpace'],
      x: ['type', 'x'],
      // Orca's desktop-layout "Where Am I" command.
      'where-am-i': ['key', '--clearmodifiers', 'KP_Enter'],
    }
    if (wayland) {
      const [, ...xdotool] = keys[key]
      const name = xdotool.at(-1)!
      const [modifier, keysym] = name.includes('+') ? name.split('+') : [undefined, name]
      const wtype =
        key === 'x'
          ? ['x']
          : modifier
            ? ['-M', modifier, '-k', keysym!, '-m', modifier]
            : ['-k', keysym!]
      await run(['wtype', ...wtype])
      return
    }
    await run(['xdotool', ...keys[key]])
  }

  utterances() {
    if (!existsSync(this.#capture)) return []
    return readFileSync(this.#capture, 'utf8').split('\n').filter(Boolean)
  }

  async stop() {
    for (const child of [this.#orca, this.#speechd, this.#xvfb, this.#keyboard]) {
      if (!child) continue
      child.kill('SIGTERM')
      const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => undefined)])
      if (exited === undefined) child.kill('SIGKILL')
      await child.exited
    }
    rmSync(this.#socketDirectory, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// macOS: VoiceOver through its AppleScript interface.

const osascript = (script: string) => run(['/usr/bin/osascript', '-e', script])

class VoiceOver implements Reader {
  readonly name = 'VoiceOver'
  #phrases: string[] = []
  #polling = false
  #poller: Promise<void> | undefined
  #pid = 0

  async start() {
    // The same private start request VoiceOver's Command-F5 shortcut makes;
    // launched any other way it waits about nine seconds for this request.
    await run([
      '/usr/bin/osascript',
      '-l',
      'JavaScript',
      '-e',
      'ObjC.bindFunction("dlopen", ["void *", ["char *", "int"]]); $.dlopen("/usr/lib/libScreenReader.dylib", 1); ObjC.bindFunction("_ScreenReaderStart", ["void", ["int"]]); $._ScreenReaderStart(0);',
    ])
    await waitFor(
      async () => (await run(['pgrep', '-x', 'VoiceOver']).catch(() => '')) !== '',
      'the VoiceOver process',
      30_000
    )
    // VoiceOver answers its own AppleEvents only after it finished starting.
    await waitFor(
      async () => {
        try {
          await osascript('tell application "VoiceOver" to return bounds of vo cursor')
          return true
        } catch {
          return false
        }
      },
      'VoiceOver to answer AppleScript (is SCREnableAppleScript set?)',
      60_000
    )
    this.#polling = true
    this.#poller = (async () => {
      while (this.#polling) {
        const phrase = await osascript(
          'tell application "VoiceOver" to return content of last phrase'
        ).catch(() => '')
        if (phrase && phrase !== this.#phrases.at(-1)) this.#phrases.push(phrase)
        await Bun.sleep(50)
      }
    })()
    const macos = await run(['sw_vers', '-productVersion'])
    return { voiceOver: 'macOS ' + macos, output: 'AppleScript content of last phrase, polled' }
  }

  async attach(pid: number) {
    this.#pid = pid
    await run([driver!, 'activate', String(pid)])
  }

  async press(key: Key) {
    if (key === 'where-am-i') throw new Error('No VoiceOver where-am-i key is driven')
    await run([driver!, 'key', String(this.#pid), key])
  }

  utterances() {
    return this.#phrases.slice()
  }

  async stop() {
    this.#polling = false
    await this.#poller
    await osascript('tell application "VoiceOver" to quit').catch(() => '')
    await waitFor(
      async () => (await run(['pgrep', '-x', 'VoiceOver']).catch(() => '')) === '',
      'VoiceOver to quit',
      10_000
    ).catch(async () => {
      await run(['pkill', '-15', '-x', 'VoiceOver']).catch(() => '')
    })
  }
}

// ---------------------------------------------------------------------------
// Windows: portable NVDA with the silence synthesizer and an IO-level log.

class Nvda implements Reader {
  readonly name = 'NVDA'
  #log = join(evidence, 'nvda.log')
  #config = join(evidence, 'nvda-config')

  async start() {
    mkdirSync(this.#config)
    // The silence synthesizer keeps the run independent of audio devices and
    // voices; NVDA logs each sequence before handing it to the synthesizer.
    writeFileSync(
      join(this.#config, 'nvda.ini'),
      [
        '[general]',
        '\tshowWelcomeDialogAtStartup = False',
        '[speech]',
        '\tsynth = silence',
        '[update]',
        '\tautoCheck = False',
        '\tstartupNotification = False',
        '\tallowUsageStats = False',
        '\taskedAllowUsageStats = True',
        '',
      ].join('\r\n')
    )
    // nvda.exe hands off to the running copy and returns; NVDA keeps running.
    Bun.spawn(
      [
        nvda!,
        '--minimal',
        '--disable-addons',
        `--config-path=${this.#config}`,
        `--log-file=${this.#log}`,
        '--log-level=12',
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
    )
    await waitFor(
      () => existsSync(this.#log) && readFileSync(this.#log, 'utf8').includes('NVDA initialized'),
      'NVDA to initialize',
      60_000
    )
    const version = /NVDA version ([^\s]+)/.exec(readFileSync(this.#log, 'utf8'))?.[1] ?? 'unknown'
    return { nvda: version, synthesizer: 'silence', output: 'NVDA log at IO level (Speaking ...)' }
  }

  async attach() {
    await run(oracle(['foreground', TITLE]))
  }

  async press(key: Key) {
    if (key === 'where-am-i') {
      // NVDA+Tab reports the current focus; NVDA treats Insert as its key.
      await run(oracle(['key', TITLE, 'nvda+tab']))
      return
    }
    await run(oracle(['key', TITLE, key]))
  }

  utterances() {
    return existsSync(this.#log) ? nvdaSpeech(readFileSync(this.#log, 'utf8')) : []
  }

  async stop() {
    await run([nvda!, '--quit']).catch(() => '')
    await Bun.sleep(1_000)
  }
}

const oracle = (args: string[]) => [
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  driver!,
  ...args,
]

/** The host is this process's direct child; its executable is the host path. */
async function hostPid(): Promise<number> {
  const children = (await run(['pgrep', '-P', String(process.pid)])).split('\n')
  for (const child of children.filter(Boolean)) {
    const command = await run(['ps', '-o', 'comm=', '-p', child])
    if (command === host || command.endsWith('/bun-native-host')) return Number(child)
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

// ---------------------------------------------------------------------------
// The scenario.

/**
 * What each platform's screen reader must say. Linux expects Orca's exact
 * phrases, in order; macOS and Windows expect a phrase that contains the
 * name and one of the role words.
 */
type Expectation = { exact: string[] } | { name: string; role: string[] } | null

// VoiceOver's and NVDA's role words for AccessKit's Button and TextInput.
const ROLE = {
  button: ['button'],
  entry: mac ? ['edit text', 'text field'] : ['edit'],
}

// Orca 46's phrases for the divider (Linux only). Orca re-announces the
// focused separator on every value change but its separator format
// (orca/formatting.py, Atspi.Role.SEPARATOR: 'focused': 'roleName +
// availability') has no value, so the number itself is never spoken; the
// AT-SPI value events and values are asserted in accessibility.ts.
const SPLIT_SPEECH = {
  search: { exact: ['entry t.'] },
  focus: { exact: ['vertical splitter Sidebar.'] },
  change: { exact: ['vertical splitter'] },
  whereAmI: { exact: ['vertical splitter Sidebar.'] },
} satisfies Record<string, Expectation>

const reader: Reader = linux ? new Orca() : mac ? new VoiceOver() : new Nvda()
let readerInfo: Record<string, unknown> = {}
const steps: Array<{
  step: string
  key: Key | null
  focus: string | null
  phrases: string[]
  missing?: Expectation
  axFocus?: unknown
}> = []
// A step whose expected phrase never came is recorded and the scenario goes on,
// so one run shows every step a screen reader misses; the run still fails.
const missed: Array<{ step: string; expected: Expectation; phrases: string[] }> = []
// macOS: steps where the host's AXFocusedUIElement was not the control the
// host reported focused.
const axMissed: Array<{ step: string; focus: string; observed: unknown }> = []
const searchValues: string[] = []
const focusNodes: NativeNode[] = []
const names = new Map<NativeNode, string>()
// Names are resolved when read: a focus event can arrive before the batch that
// created its control has returned the handle.
const focusTrace = () => focusNodes.map((node) => names.get(node) ?? 'other')
const app = await (async () => {
  readerInfo = await reader.start()
  record('reader', readerInfo)
  if (linux) record('session', wayland ? 'wayland (headless sway)' : 'x11 (Xvfb + openbox)')
  return createApplication({ executable: host })
})()
assert(app.capabilities.includes('accessibility_v1' as never), 'accessibility_v1')
let dialogOpen = false
try {
  const window = await app.openWindow({ title: TITLE, width: 520, height: 360 })
  // Focus events bubble to the root, and this listener exists before any
  // control does, so the host's initial input focus cannot precede it.
  window.on(window.root, 'focus', (event) => void focusNodes.push(event.node))
  const nodes = await window.batch((batch) => {
    batch.set(window.root, {
      kind: 'box',
      style: { direction: 'column', gap: 8, padding: 12, background: 0xffffff },
    })
    const add = <N extends NativeNode>(node: N) => {
      batch.append(window.root, node)
      return node
    }
    add(batch.create({ kind: 'text', text: 'Screen reader qualification' }))
    const search = add(
      batch.create({ kind: 'input', value: 'typed', placeholder: 'Search', style: { height: 36 } })
    )
    const action = add(batch.create({ kind: 'button', text: 'Leading action' }))
    const fixed = add(
      batch.create({ kind: 'input', value: 'Fixed', read_only: true, style: { height: 36 } })
    )
    add(batch.create({ kind: 'button', text: 'Disabled action', disabled: true }))
    const open = add(batch.create({ kind: 'button', text: 'Open dialog' }))
    return { search, action, fixed, open }
  })
  const watch = (node: NativeNode, name: string) => void names.set(node, name)
  watch(nodes.search, 'search')
  watch(nodes.action, 'action')
  watch(nodes.fixed, 'fixed')
  watch(nodes.open, 'open')
  window.onInput(nodes.search, (event) => void searchValues.push(event.value))
  window.onClick(nodes.open, async () => {
    const dialog = await window.batch((batch) => {
      const layer = batch.create({
        kind: 'overlay',
        modal: true,
        accessible_label: 'Confirm dialog',
        style: { padding: 24, gap: 8, background: 0xf4f5f7 },
      })
      batch.append(window.root, layer)
      batch.append(layer, batch.create({ kind: 'text', text: 'Discard changes?' }))
      const confirm = batch.create({ kind: 'button', text: 'Confirm' })
      const cancel = batch.create({ kind: 'button', text: 'Cancel' })
      batch.append(layer, confirm)
      batch.append(layer, cancel)
      return { layer, confirm, cancel }
    })
    watch(dialog.confirm, 'confirm')
    watch(dialog.cancel, 'cancel')
    window.onClick(dialog.cancel, async () => {
      await window.batch((batch) => batch.remove(dialog.layer))
      dialogOpen = false
    })
    dialogOpen = true
  })

  await waitFor(() => focusTrace().includes('search'), 'initial input focus')
  const pid = mac ? await hostPid() : 0
  await reader.attach(pid)

  // What VoiceOver asks the application for: its AXFocusedUIElement.
  interface AxFocus {
    active: boolean
    window: string | null
    element: { role: string; title: string; description: string; value: unknown } | null
  }
  const AX_FOCUS: Record<string, { role: string; name?: string }> = {
    search: { role: 'AXTextField' },
    action: { role: 'AXButton', name: 'Leading action' },
    fixed: { role: 'AXTextField', name: 'Fixed' },
    open: { role: 'AXButton', name: 'Open dialog' },
    confirm: { role: 'AXButton', name: 'Confirm' },
    cancel: { role: 'AXButton', name: 'Cancel' },
  }
  const axFocusMatches = (observed: AxFocus, focus: string) => {
    const expected = AX_FOCUS[focus]
    const element = observed.element
    if (!expected || !element || element.role !== expected.role) return false
    const named = [element.title, element.description, element.value]
    if (expected.name !== undefined) return named.includes(expected.name)
    // The editable input: any value but the read-only field's.
    return element.value !== 'Fixed'
  }
  const readAxFocus = async (): Promise<AxFocus> =>
    JSON.parse(await run([axOracle!, 'focused', String(pid)])) as AxFocus
  /** AccessKit updates after a frame; allow two seconds for the focus to arrive. */
  const checkAxFocus = async (label: string, focus: string) => {
    let observed = await readAxFocus()
    const until = performance.now() + 2_000
    while (!axFocusMatches(observed, focus) && performance.now() < until) {
      await Bun.sleep(100)
      observed = await readAxFocus()
    }
    if (!axFocusMatches(observed, focus)) {
      console.error(
        `${label}: the host's AXFocusedUIElement is not ${focus}: ${JSON.stringify(observed)}`
      )
      axMissed.push({ step: label, focus, observed })
    }
    return observed
  }

  const matches = (phrases: string[], expected: Expectation) => {
    if (expected === null) return true
    if ('exact' in expected) {
      // Orca's phrases, in order, among everything said for this step.
      let index = 0
      for (const phrase of phrases) if (phrase === expected.exact[index]) index += 1
      return index === expected.exact.length
    }
    return phrases.some((phrase) => {
      const lower = phrase.toLowerCase()
      return (
        lower.includes(expected.name.toLowerCase()) &&
        expected.role.some((role) => lower.includes(role))
      )
    })
  }
  /**
   * Press one key (or none), wait for the focus the host must report and the
   * phrase the screen reader must say, then let late phrases settle.
   */
  const step = async (
    label: string,
    key: Key | null,
    focus: string | null,
    expected: Expectation,
    settle = 400
  ) => {
    const from =
      key === null && focus !== null && steps.length === 0 ? 0 : reader.utterances().length
    const focusFrom = focusTrace().length
    if (key) await reader.press(key)
    if (focus)
      await waitFor(
        () => (key ? focusTrace().slice(focusFrom).includes(focus) : focusTrace().at(-1) === focus),
        `${label}: host focus on ${focus}`,
        10_000,
        () => focusTrace().join()
      )
    const axFocus = mac && focus ? await checkAxFocus(label, focus) : undefined
    let spoken = true
    await waitFor(
      () => matches(reader.utterances().slice(from), expected),
      `${label}: ${reader.name} speech ${JSON.stringify(expected)}`,
      15_000,
      () => JSON.stringify(reader.utterances().slice(from))
    ).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.startsWith('Timed out')) throw error
      console.error(error.message)
      spoken = false
    })
    await Bun.sleep(settle)
    const phrases = reader.utterances().slice(from)
    if (spoken) steps.push({ step: label, key, focus, phrases, axFocus })
    else {
      steps.push({ step: label, key, focus, phrases, missing: expected, axFocus })
      missed.push({ step: label, expected, phrases })
    }
    console.log(JSON.stringify({ step: label, phrases, spoken, ...(axFocus ? { axFocus } : {}) }))
    return phrases
  }
  const per = (exact: string[], other: Expectation): Expectation => (linux ? { exact } : other)
  // Phrases Orca derives from the key it saw. On sway nothing reports keys to
  // Orca: with WAYLAND_DISPLAY set, libatspi gives Orca its legacy device,
  // which hears only keys an application forwards to the AT-SPI registry's
  // DeviceEventController, and AccessKit forwards none (Orca's debug log has
  // no KEYBOARD EVENT on Wayland). Key echo and the character at a moved caret
  // are therefore not spoken there, and Orca's own commands (Where Am I) never
  // reach it; the keys still reach the host and are checked through Bun.
  const keyed = (expected: Expectation): Expectation => (wayland ? null : expected)

  // The window and the input that owns initial focus. Before the host routed
  // AppKit's focused-element query from GPUI's first-responder view to the
  // AccessKit adapter on the content view and repeated the key-window
  // notification for it (native/macos-surface/src/focus_route.rs and
  // key_status.rs), the application reported its window as the focused
  // element: VoiceOver on macOS 15 read the window, put its cursor on the
  // first element, the text ("... window Screen reader qualification has
  // keyboard focus", Validation run 42962662996), and then said nothing for
  // any later focus change.
  await step(
    'window activated',
    null,
    'search',
    per(['entry typed.'], { name: 'typed', role: ROLE.entry })
  )
  // Keyboard-only Tab order; the disabled button is skipped and never spoken.
  await step(
    'Tab to button',
    'tab',
    'action',
    per(['Leading action push button.'], { name: 'Leading action', role: ROLE.button })
  )
  await step(
    'Tab to read-only input',
    'tab',
    'fixed',
    per(['read only entry Fixed.'], { name: 'Fixed', role: ROLE.entry })
  )
  await step(
    'Tab past the disabled button',
    'tab',
    'open',
    per(['Open dialog push button.'], { name: 'Open dialog', role: ROLE.button })
  )
  await step(
    'Tab wraps to the input',
    'tab',
    'search',
    per(['entry typed.'], { name: 'typed', role: ROLE.entry })
  )
  // Editing: typed text reaches Bun, and the screen reader reads the new value,
  // characters at the moved caret, a selection and its deletion.
  await step('End', 'end', null, null)
  await step('Type x', 'x', null, keyed(per(['x'], null)))
  await waitFor(
    () => searchValues.at(-1) === 'typedx',
    'typed input value',
    5_000,
    () => searchValues.join()
  )
  // Orca's and NVDA's "where am I" commands read the focused control again,
  // now with the value the application changed. VoiceOver has no
  // AppleScript or single-key equivalent driven here.
  if (!mac && !wayland)
    await step(
      'Where am I',
      'where-am-i',
      null,
      per(['entry typedx.'], { name: 'typedx', role: ROLE.entry })
    )
  await step('Left', 'left', null, keyed(per(['x'], null)))
  await step('Home', 'home', null, keyed(per(['t'], null)))
  await step('Right', 'right', null, keyed(per(['y'], null)))
  await step('Shift+End', 'shift+end', null, per(['ypedx', 'selected'], null))
  await step('Backspace', 'backspace', null, per(['Selection deleted.'], null))
  await waitFor(
    () => searchValues.at(-1) === 't',
    'selection deleted',
    5_000,
    () => searchValues.join()
  )
  // A modal dialog: its name, role and first control, then Tab inside it.
  await step(
    'Shift+Tab wraps to the last button',
    'shift+tab',
    'open',
    per(['Open dialog push button.'], { name: 'Open dialog', role: ROLE.button })
  )
  await step(
    'Space opens the dialog',
    'space',
    'confirm',
    per(['Confirm dialog dialog Discard changes?', 'Confirm push button.'], {
      name: 'Confirm',
      role: ROLE.button,
    })
  )
  assert(dialogOpen, 'the dialog opened')
  await step(
    'Tab inside the dialog',
    'tab',
    'cancel',
    per(['Cancel push button.'], { name: 'Cancel', role: ROLE.button })
  )
  // Closing it returns focus to the button that opened it, and the content
  // that was hidden beneath the dialog is announced again.
  await step(
    'Space closes the dialog',
    'space',
    'open',
    per(['Open dialog push button.'], { name: 'Open dialog', role: ROLE.button })
  )
  assert(!dialogOpen, 'the dialog closed')
  await step(
    'Tab after the dialog closed',
    'tab',
    'search',
    per(['entry t.'], { name: 't', role: ROLE.entry })
  )
  await step(
    'Tab to the button after the dialog closed',
    'tab',
    'action',
    per(['Leading action push button.'], { name: 'Leading action', role: ROLE.button })
  )

  // Linux: a value change on the focused control. A split appended after
  // every other control puts its divider last in Tab order; Orca reads the
  // divider on focus and each new value as Right and End move it.
  if (linux) {
    const split = await window.batch((batch) => {
      const split = batch.create({
        kind: 'split',
        ratio: 0.4,
        min_size: 50,
        accessible_label: 'Sidebar',
        style: { width: 400, height: 40, flex_shrink: 0 },
      })
      batch.append(window.root, split)
      batch.append(split, batch.create({ kind: 'box', style: { width: 'fill' } }))
      batch.append(split, batch.create({ kind: 'box', style: { width: 'fill' } }))
      return split
    })
    watch(split, 'divider')
    const resizes: number[] = []
    onSplitResize(window, split, (event) => void resizes.push(event.ratio))
    await step('Shift+Tab to the input', 'shift+tab', 'search', SPLIT_SPEECH.search)
    await step('Shift+Tab wraps to the divider', 'shift+tab', 'divider', SPLIT_SPEECH.focus)
    await step('Right moves the divider', 'right', null, SPLIT_SPEECH.change)
    await waitFor(() => resizes.length === 1, 'the Right resize')
    await step('End moves the divider to its limit', 'end', null, SPLIT_SPEECH.change)
    await waitFor(() => resizes.length === 2, 'the End resize')
    if (!wayland) await step('Where am I on the divider', 'where-am-i', null, SPLIT_SPEECH.whereAmI)
    record('dividerValues', resizes.slice())
    const expected = [0.41, 1 - 50 / (400 - 6)]
    assert(
      resizes.length === 2 && resizes.every((ratio, i) => Math.abs(ratio - expected[i]!) < 1e-9),
      `one split_resize per key: ${resizes.join()}`
    )
  }

  const spoken = reader.utterances()
  assert(
    !spoken.some((phrase) => phrase.includes('Disabled action')),
    'the disabled button is never focused or announced'
  )
  record('steps', steps)
  record('values', searchValues.slice())
  record('focus', focusTrace())
  // The host's exposure is checked before the screen reader: a phrase cannot
  // follow a focus the platform tree never reported.
  assert.deepEqual(axMissed, [], "the host's AXFocusedUIElement followed every focus change")
  assert.deepEqual(missed, [], `${reader.name} said every expected phrase`)
  await window.close()
} finally {
  writeFileSync(
    join(evidence, 'utterances.json'),
    JSON.stringify(
      { reader: reader.name, utterances: reader.utterances(), steps, missed, axMissed },
      null,
      2
    ) + '\n'
  )
  await app.shutdown()
  await app.closed
  await reader.stop()
}
assert(Object.values(app.diagnostics).every((count) => count === 0))
const result = {
  status: 'passed',
  scenario: 'screen-reader',
  platform,
  ...(linux ? { session: wayland ? 'wayland' : 'x11' } : {}),
  reader: reader.name,
  readerInfo,
  mode,
  elapsedMs: Math.round(performance.now() - started),
  outcomes,
}
writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ status: 'passed', platform, reader: reader.name, mode }))
