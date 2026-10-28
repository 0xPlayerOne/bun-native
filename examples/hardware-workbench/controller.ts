import {
  requireCapability,
  type SessionHandle,
  type ViewHandle,
  type ViewPresentationOptions,
  type WindowHandle,
} from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import type { RpcContext } from '../../packages/runtime/src/rpc.ts'
import type { RpcIdentity } from '../../packages/runtime/src/rpc-authority.ts'
import {
  parseWorkbenchCommand,
  previewNames,
  type PreviewName,
  type WorkbenchCommand,
  type WorkbenchSnapshot,
} from './contract.ts'

type Role = 'controls' | 'overlay'
interface Binding {
  readonly role: Role
  readonly view: ViewHandle
  readonly document: string
  readonly url: string
  identity?: RpcIdentity
}

/** Additional application routing over the native-authenticated RpcContext.
 * A renderer-supplied role, pane name or copied resource ID is never a binding.
 */
export class WorkbenchAuthority {
  readonly #bindings = new Map<Role, Binding>()
  constructor(private readonly backend: Pick<CefBackend, 'state'>) {}
  bind(role: Role, view: ViewHandle): void {
    const state = this.backend.state(view)
    const url = `app://ui/${role === 'controls' ? 'index' : 'overlay'}.html`
    if (
      state.url !== url ||
      state.trust.kind !== 'application' ||
      state.trust.origin !== 'app://ui'
    )
      throw new Error('Invalid workbench application owner')
    this.#bindings.set(role, { role, view, url, document: state.documentId })
  }
  retire(role: Role): void {
    this.#bindings.delete(role)
  }
  check(context: RpcContext, command?: WorkbenchCommand): Binding {
    if (context.signal.aborted) throw new Error('Workbench request cancelled')
    const owner = [...this.#bindings.values()].find(
      (binding) => binding.view.id === context.identity.viewId
    )
    if (!owner) throw new Error('Workbench owner unavailable')
    const state = this.backend.state(owner.view)
    const actual = context.identity
    if (
      actual.origin !== 'app://ui' ||
      actual.documentId !== owner.document ||
      state.documentId !== owner.document ||
      state.url !== owner.url ||
      state.trust.kind !== 'application' ||
      state.trust.origin !== 'app://ui'
    )
      throw new Error('Workbench document authority revoked')
    if (
      owner.identity &&
      (actual.frameId !== owner.identity.frameId ||
        actual.generation !== owner.identity.generation ||
        actual.documentId !== owner.identity.documentId ||
        actual.origin !== owner.identity.origin)
    )
      throw new Error('Workbench connection authority changed')
    owner.identity ??= Object.freeze({ ...actual })
    if (command && owner.role === 'overlay' && command.action !== 'dismiss-overlay')
      throw new Error('Overlay command denied')
    if (command?.action === 'dismiss-overlay' && owner.role !== 'overlay')
      throw new Error('Overlay dismissal requires its current owner')
    return owner
  }
}

export function numericLoopbackOrigin(value: string): string {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value))
    throw new Error('Workbench requires a numeric-loopback fixture origin')
  const port = Number(value.slice(value.lastIndexOf(':') + 1))
  if (port > 65535 || new URL(value).origin !== value) throw new Error('Invalid fixture port')
  return value
}

interface PaneOwner {
  readonly view: ViewHandle
  readonly session: SessionHandle
}
const paneBounds = (name: PreviewName, width = 400, height = 500) => ({
  x: name === 'left' ? 380 : 796,
  y: 12,
  width,
  height,
})
const overlayPresentation: ViewPresentationOptions = {
  bounds: { x: 600, y: 128, width: 440, height: 330 },
  tabIndex: 3,
}

/** Owns only example resources. Native owners, deadlines and authority remain in the SDK. */
export class HardwareWorkbench {
  readonly #authority: WorkbenchAuthority
  readonly #panes = new Map<PreviewName, PaneOwner>()
  readonly #incarnations: Record<PreviewName, number> = { left: 0, right: 0 }
  readonly #events: { sequence: number; elapsedMs: number; message: string }[] = []
  readonly #started = performance.now()
  #sequence = 0
  #heartbeat = 0
  #phase: WorkbenchSnapshot['phase'] = 'starting'
  #window?: WindowHandle
  #controls?: PaneOwner
  #overlay: PaneOwner | undefined
  #busy = false
  #fullscreenPending = false
  #removeWindow = () => {}
  #restoreTimer: ReturnType<typeof setTimeout> | undefined
  #pulse?: ReturnType<typeof setInterval>
  #last: WorkbenchSnapshot = {
    phase: 'starting',
    heartbeat: 0,
    observedAtMs: 0,
    window: null,
    panes: previewNames.map((name) => ({ name, incarnation: 0, native: null })),
    overlay: null,
    events: [],
    discardedEvents: 0,
  }

  constructor(
    private readonly backend: CefBackend,
    private readonly fixtureOrigin: string
  ) {
    numericLoopbackOrigin(fixtureOrigin)
    this.#authority = new WorkbenchAuthority(backend)
  }
  #log(message: string): void {
    if (this.#events.length === 48) this.#events.shift()
    this.#events.push({
      sequence: ++this.#sequence,
      elapsedMs: Math.round(performance.now() - this.#started),
      message,
    })
  }
  async start(): Promise<void> {
    for (const capability of ['window.state', 'window.geometry', 'view.composition'] as const)
      requireCapability(this.backend.descriptor, capability)
    const window = (this.#window = await this.backend.createWindow({
      title: 'Bunly — M7 hardware workbench',
      bounds: { x: 40, y: 40, width: 1240, height: 860 },
      viewLayout: 'manual',
    }))
    this.#removeWindow = this.backend.onWindowEvent(window, (event) => {
      if (event.type === 'fullscreen-transition') this.#fullscreenPending = !event.completed
      if (event.type === 'closed') {
        this.#phase = 'closing'
        this.#log('Final window closed')
      } else
        this.#log(
          `Window ${event.type}: ${JSON.stringify(event.type === 'bounds-changed' ? event.bounds : event.state)}${event.type === 'fullscreen-transition' ? ` completed=${event.completed}` : ''}`
        )
    })
    this.#controls = await this.#application('controls', {
      bounds: { x: 12, y: 12, width: 348, height: 810 },
      tabIndex: 0,
    })
    for (const name of previewNames) await this.#createPane(name)
    await this.#createOverlay()
    this.#phase = 'ready'
    this.#log(
      'Ready: two remote previews, independent ephemeral sessions, no automatic case results'
    )
    this.#pulse = setInterval(() => {
      this.#heartbeat++
    }, 1000)
    await this.#capture()
  }
  async #rollback(view: ViewHandle | undefined, session: SessionHandle): Promise<void> {
    try {
      if (view) await this.backend.disposeView(view)
      await this.backend.disposeSession(session)
    } catch (error) {
      // Do not keep an interactive application running after uncertain rollback.
      // The existing native disposal path retains its ordinary owner/deadline rules.
      this.#phase = 'closing'
      this.#log('Creation rollback failed; ending the workbench')
      await this.backend.dispose()
      throw error
    }
  }
  async #application(
    role: Role,
    presentation: ViewPresentationOptions,
    check = () => {}
  ): Promise<PaneOwner> {
    check()
    const session = await this.backend.createSession({
      persistence: 'ephemeral',
      partition: `hardware-${role}`,
    })
    let view: ViewHandle | undefined
    try {
      check()
      view = await this.backend.createView({
        window: this.#window!,
        session,
        url: `app://ui/${role === 'controls' ? 'index' : 'overlay'}.html`,
        trust: { kind: 'application', origin: 'app://ui' },
        presentation,
        layer: role === 'overlay' ? 'overlay' : 'content',
      })
      check()
      this.#authority.bind(role, view)
      return { view, session }
    } catch (error) {
      await this.#rollback(view, session)
      throw error
    }
  }
  async #createPane(name: PreviewName, check = () => {}): Promise<void> {
    check()
    const session = await this.backend.createSession({
      persistence: 'ephemeral',
      partition: `hardware-${name}`,
      network: { allowedOrigins: [this.fixtureOrigin] },
    })
    let view: ViewHandle | undefined
    try {
      check()
      view = await this.backend.createView({
        window: this.#window!,
        session,
        url: `${this.fixtureOrigin}/${name}.html`,
        trust: { kind: 'remote' },
        presentation: { bounds: paneBounds(name), tabIndex: name === 'left' ? 1 : 2 },
      })
      check()
      this.#panes.set(name, { view, session })
      this.#incarnations[name]++
      this.#log(`${name} preview created, incarnation ${this.#incarnations[name]}`)
    } catch (error) {
      await this.#rollback(view, session)
      throw error
    }
  }
  async #createOverlay(check = () => {}): Promise<void> {
    const owner = await this.#application(
      'overlay',
      { ...overlayPresentation, visible: false },
      check
    )
    try {
      check()
    } catch (error) {
      this.#authority.retire('overlay')
      await this.#rollback(owner.view, owner.session)
      throw error
    }
    this.#overlay = owner
    this.#log('Native overlay created hidden')
  }
  #pane(name: PreviewName): PaneOwner {
    const owner = this.#panes.get(name)
    if (!owner) throw new Error('Preview is closed; reopen it first')
    return owner
  }
  async #closeOverlay(): Promise<void> {
    const owner = this.#overlay
    if (!owner) return
    this.#authority.retire('overlay')
    await this.backend.disposeView(owner.view)
    await this.backend.disposeSession(owner.session)
    this.#overlay = undefined
    this.#log('Native overlay disposed')
  }
  async #capture(check = () => {}): Promise<WorkbenchSnapshot> {
    check()
    const state = await this.backend.windowState(this.#window!)
    check()
    const bounds = await this.backend.windowBounds(this.#window!)
    const panes: WorkbenchSnapshot['panes'][number][] = []
    for (const name of previewNames) {
      check()
      const owner = this.#panes.get(name)
      panes.push({
        name,
        incarnation: this.#incarnations[name],
        native: owner ? await this.backend.viewPresentation(owner.view) : null,
      })
    }
    check()
    const overlay = this.#overlay ? await this.backend.viewPresentation(this.#overlay.view) : null
    check()
    this.#last = {
      phase: this.#phase,
      heartbeat: this.#heartbeat,
      observedAtMs: Math.round(performance.now() - this.#started),
      window: { state, bounds },
      panes,
      overlay,
      events: [...this.#events],
      discardedEvents: this.#sequence - this.#events.length,
    }
    return this.#last
  }
  async snapshot(context: RpcContext): Promise<WorkbenchSnapshot> {
    const check = () => {
      this.#authority.check(context)
    }
    check()
    if (this.#busy || this.#phase !== 'ready') return this.#last
    this.#busy = true
    try {
      return await this.#capture(check)
    } finally {
      this.#busy = false
    }
  }
  async command(input: WorkbenchCommand, context: RpcContext): Promise<null> {
    const command = parseWorkbenchCommand(input)
    const owner = this.#authority.check(context, command)
    const check = () => {
      if (this.#authority.check(context, command) !== owner)
        throw new Error('Workbench owner changed')
    }
    if (this.#phase !== 'ready' || this.#busy) throw new Error('Workbench busy; try again')
    this.#busy = true
    try {
      await this.#execute(command, context.signal, check)
      if (command.action !== 'quit') {
        check()
        await this.#capture(check)
      }
      return null
    } catch (error) {
      this.#log(`Command ${command.action} failed; no success inferred`)
      throw error
    } finally {
      this.#busy = false
    }
  }
  async #execute(command: WorkbenchCommand, signal: AbortSignal, check: () => void): Promise<void> {
    const window = this.#window!
    const options = { signal }
    switch (command.action) {
      case 'focus':
        await this.backend.focusView(this.#pane(command.pane).view, options)
        break
      case 'present': {
        const bounds = paneBounds(command.pane, command.width, command.height)
        await this.backend.setViewPresentation(
          this.#pane(command.pane).view,
          {
            bounds,
            visible: command.visible,
            focusable: command.focusable,
            tabIndex: command.pane === 'left' ? 1 : 2,
            clip:
              command.clip === 'none'
                ? null
                : command.clip === 'full'
                  ? { x: 0, y: 0, width: 0, height: 0 }
                  : {
                      ...bounds,
                      width: Math.floor(bounds.width / 2),
                      height: Math.floor(bounds.height / 2),
                    },
          },
          options
        )
        break
      }
      case 'traverse':
        await this.backend.focusNextView(window, command.reverse, options)
        break
      case 'close-pane': {
        const pane = this.#pane(command.pane)
        await this.backend.disposeView(pane.view)
        // Retain the session owner until actual disposal has settled.
        await this.backend.disposeSession(pane.session)
        this.#panes.delete(command.pane)
        break
      }
      case 'reopen-pane':
        if (this.#panes.has(command.pane)) throw new Error('Preview is already open')
        // Native content must precede overlays; this explicit action resets overlay text/state.
        await this.#closeOverlay()
        check()
        await this.#createPane(command.pane, check)
        check()
        await this.#createOverlay(check)
        break
      case 'overlay':
        if (command.state === 'closed') {
          await this.#closeOverlay()
          break
        }
        if (!this.#overlay) {
          await this.#createOverlay(check)
          check()
        }
        await this.backend.setViewPresentation(
          this.#overlay!.view,
          { ...overlayPresentation, visible: command.state === 'open' },
          options
        )
        if (command.state === 'open') {
          check()
          await this.backend.focusView(this.#overlay!.view, options)
        } else {
          check()
          await this.backend.focusView(this.#controls!.view, options)
        }
        break
      case 'dismiss-overlay':
        await this.backend.setViewPresentation(
          this.#overlay!.view,
          { ...overlayPresentation, visible: false },
          options
        )
        check()
        await this.backend.focusView(this.#controls!.view, options)
        break
      case 'resize-window': {
        const sizes = { compact: [920, 680], regular: [1240, 860], large: [1600, 1000] } as const
        const [width, height] = sizes[command.size]
        await this.backend.resizeWindow(window, width, height, options)
        break
      }
      case 'window':
        switch (command.operation) {
          case 'activate':
            await this.backend.activateWindow(window, options)
            break
          case 'minimize':
            await this.backend.minimizeWindow(window, options)
            break
          case 'maximize':
            await this.backend.maximizeWindow(window, options)
            break
          case 'restore':
            await this.backend.restoreWindow(window, options)
            break
          case 'fullscreen':
          case 'windowed':
            if (this.#fullscreenPending)
              throw new Error('Wait for the native fullscreen completion event')
            if (
              (await this.backend.windowState(window, options)).fullscreen ===
              (command.operation === 'fullscreen')
            )
              break
            check()
            this.#fullscreenPending = true
            try {
              await this.backend.setWindowFullscreen(
                window,
                command.operation === 'fullscreen',
                options
              )
            } catch (error) {
              this.#fullscreenPending = false
              throw error
            }
            break
          case 'hide-briefly':
            if (this.#restoreTimer) throw new Error('A timed hide is already pending')
            // Explicit operator action, fixed 5-second recovery; never an acceptance deadline.
            this.#restoreTimer = setTimeout(() => {
              this.#restoreTimer = undefined
              if (this.#phase === 'ready')
                void this.backend
                  .showWindow(window, true)
                  .catch(() => this.#log('Timed show failed; inspect native lifecycle'))
            }, 5000)
            await this.backend.showWindow(window, false, options)
            break
        }
        break
      case 'quit':
        this.#phase = 'closing'
        this.#log('Operator requested final window close')
        await this.backend.closeWindow(window)
        break
    }
    this.#log(
      `Command ${command.action} completed; physical behavior requires operator observation`
    )
  }
  stop(): void {
    this.#phase = 'closing'
    clearInterval(this.#pulse)
    clearTimeout(this.#restoreTimer)
    this.#removeWindow()
    this.#authority.retire('controls')
    this.#authority.retire('overlay')
  }
}
