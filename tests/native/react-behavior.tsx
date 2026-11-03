/** @jsxImportSource @bun-native/react */
import { createApplication, type ClickEvent } from '@bun-native/core'
import { render, type NativeRef, type ReactRenderRoot } from '@bun-native/react'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  Component,
  createContext,
  createRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { recordEvidence } from '../../examples/native-window/content.ts'

const scenarios = [
  'lifecycle',
  'boundary-fallback',
  'boundary-recovery',
  'recoverable-retry',
  'throwing-reporter',
  'cleanup-effect',
  'cleanup-ref',
  'transition',
] as const
type Scenario = (typeof scenarios)[number]
function isScenario(value: string | undefined): value is Scenario {
  return scenarios.some((scenario) => scenario === value)
}
const scenario = process.env['BUN_NATIVE_REACT_BEHAVIOR']
const executable = process.env['BUN_NATIVE_HOST']
const evidencePath = process.env['BUN_NATIVE_EVIDENCE_LOG']
if (
  !isScenario(scenario) ||
  !executable ||
  !evidencePath ||
  !process.env['BUN_NATIVE_EVIDENCE_NONCE']
)
  throw new Error('Use the owned React behavior harness with an explicit scenario and host')

async function bounded<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`React behavior timed out: ${operation}`)),
          15_000
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const terminal = ['throwing-reporter', 'cleanup-effect', 'cleanup-ref'].includes(scenario)
const originalRenderError = new Error('Expected React render failure')
const originalTerminalError = new Error(`Expected React ${scenario} failure`)
const activation = Promise.withResolvers<ClickEvent>()
const transitionCommitted = Promise.withResolvers<void>()
const frameRef = createRef<NativeRef>()
const labelRef = createRef<NativeRef>()
const prefix = createContext('State')
const traces: string[] = []
const caught: unknown[] = []
const recovered: unknown[] = []
const pendingSnapshots: boolean[] = []
let buttonAttachments = 0
let buttonCleanups = 0
let retryAttempts = 0
let committedValue = 0
let click: ClickEvent | undefined
let update!: (value: number) => void
let transitionAtOrdinaryFlush: boolean | undefined
let hookIdentity: object | undefined
let frameIdentity: NativeRef | null = null
let labelIdentity: NativeRef | null = null
let root: ReactRenderRoot | undefined
let survivor: ReactRenderRoot | undefined
let qualified = false
let terminalRejected = false
let failure: unknown
const record = (event: Record<string, unknown>) => recordEvidence({ scenario, ...event })

function observeClick(event: ClickEvent): void {
  assert.equal(click, undefined, 'Exactly one owned OS activation is required')
  assert(!event.signal.aborted)
  assert.equal(event.type, 'click')
  assert.equal(event.node.kind, 'button')
  click = event
  record({ type: 'react-behavior-activation', sequence: event.sequence })
  activation.resolve(event)
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    assert.equal(error, originalRenderError, 'The boundary must receive the original error')
    assert.equal(typeof info.componentStack, 'string')
    caught.push(error)
    traces.push('boundary:caught')
  }
  override render() {
    return this.state.failed ? <text text="Fallback" style={{ height: 28 }} /> : this.props.children
  }
}

function Label({ value, text, fail }: { value: number; text: string; fail: boolean }) {
  useLayoutEffect(() => {
    traces.push(`label:layout:${value}`)
    committedValue = value
    if (scenario === 'transition' && value === 1) transitionCommitted.resolve()
    return () => {
      traces.push(`label:layout-cleanup:${value}`)
    }
  }, [value])
  useEffect(() => {
    traces.push(`label:passive:${value}`)
    return () => {
      traces.push(`label:passive-cleanup:${value}`)
    }
  }, [value])
  if (fail) throw originalRenderError
  if (
    (scenario === 'recoverable-retry' || scenario === 'throwing-reporter') &&
    value === 1 &&
    retryAttempts++ === 0
  )
    throw originalRenderError
  return <text ref={labelRef} text={text} style={{ height: 28 }} />
}

function App() {
  const [value, setValue] = useState(0)
  const [reduced, dispatch] = useReducer((current: number) => current + 1, 0)
  const [failed, setFailed] = useState(scenario === 'boundary-recovery')
  const [generation, setGeneration] = useState(0)
  const [pending, startTransition] = useTransition()
  const identity = useRef({})
  const context = useContext(prefix)
  const text = useMemo(
    () =>
      scenario === 'lifecycle'
        ? `${context} ${value} / Reducer ${reduced}`
        : scenario === 'boundary-fallback' || scenario === 'boundary-recovery'
          ? `Healthy ${value}`
          : `${context} ${value}`,
    [context, value, reduced]
  )
  update = setValue
  const buttonRef = useCallback((instance: NativeRef | null) => {
    assert(instance, 'The callback ref attaches with an opaque native reference')
    buttonAttachments++
    traces.push('button:attach')
    return () => {
      buttonCleanups++
      traces.push('button:cleanup')
      if (scenario === 'cleanup-ref') throw originalTerminalError
    }
  }, [])
  useLayoutEffect(() => {
    hookIdentity = identity.current
    traces.push('owner:layout')
    return () => {
      traces.push('owner:layout-cleanup')
    }
  }, [])
  useLayoutEffect(() => {
    assert.equal(identity.current, hookIdentity, 'useRef identity survives committed updates')
    pendingSnapshots.push(pending)
  })
  useEffect(() => {
    traces.push('owner:passive')
    return () => {
      traces.push('owner:passive-cleanup')
      if (scenario === 'cleanup-effect') throw originalTerminalError
    }
  }, [])

  function activate(event: ClickEvent) {
    if (scenario === 'lifecycle') {
      setValue((current) => current + 1)
      setValue((current) => current + 1)
      dispatch()
      dispatch()
    } else if (scenario === 'boundary-fallback') setFailed(true)
    else if (scenario === 'boundary-recovery') {
      setFailed(false)
      setGeneration((current) => current + 1)
      setValue(1)
    } else if (scenario === 'transition') startTransition(() => setValue(1))
    observeClick(event)
  }

  const label = <Label value={value} text={text} fail={failed} />
  return (
    <box ref={frameRef} style={{ direction: 'column', padding: 24, gap: 12 }}>
      <text text="React behavior" style={{ height: 32, font_size: 24 }} />
      {scenario === 'boundary-fallback' || scenario === 'boundary-recovery' ? (
        <Boundary key={generation}>{label}</Boundary>
      ) : (
        label
      )}
      <button
        ref={buttonRef}
        text="Run behavior"
        onClick={activate}
        style={{ width: 240, height: 44 }}
      />
    </box>
  )
}

function count(trace: string): number {
  return traces.filter((entry) => entry === trace).length
}

function assertReleased() {
  assert.equal(frameRef.current, null)
  assert.equal(labelRef.current, null)
  assert.equal(buttonAttachments, 1)
  assert.equal(buttonCleanups, 1)
  assert.equal(count('owner:layout'), 1)
  assert.equal(count('owner:layout-cleanup'), 1)
  assert.equal(count('owner:passive'), 1)
  assert.equal(count('owner:passive-cleanup'), 1)
  assert.equal(root!.diagnostics.nodes, 0)
  assert.equal(root!.diagnostics.listeners, 0)
  assert.equal(root!.diagnostics.pending, false)
  assert(click?.signal.aborted, 'Disposal must revoke the observed callback lifetime')
  for (const kind of ['layout', 'passive']) {
    let previousCleanup = -1
    for (const value of [0, 1, 2]) {
      const setup = `label:${kind}:${value}`
      const cleanup = `label:${kind}-cleanup:${value}`
      const setups = count(setup)
      if (!setups) {
        assert.equal(count(cleanup), 0, 'An uncommitted effect cannot have cleanup')
        continue
      }
      assert.equal(setups, 1)
      assert.equal(count(cleanup), 1, 'Every committed effect must clean up exactly once')
      assert(traces.indexOf(setup) > previousCleanup, 'An update cleans the previous effect first')
      previousCleanup = traces.indexOf(cleanup)
      assert(previousCleanup > traces.indexOf(setup))
    }
  }
}

const application = await createApplication({ executable: resolve(executable) })
try {
  assert(application.capabilities.includes('interactions_v1'))
  const window = await application.openWindow({
    title: 'Bun Native React Behavior',
    width: 640,
    height: 420,
  })
  root = render(
    <prefix.Provider value="State">
      <App />
    </prefix.Provider>,
    window,
    {
      onRecoverableError(error, info) {
        assert(error instanceof Error)
        assert.equal(error.cause, originalRenderError)
        assert(Object.isFrozen(info))
        recovered.push(error)
        traces.push('render:recovered')
        if (scenario === 'throwing-reporter') throw originalTerminalError
      },
    }
  )
  await bounded(root.ready, 'initial native acknowledgement')
  assert(frameRef.current)
  frameIdentity = frameRef.current
  labelIdentity = labelRef.current
  assert.equal(buttonAttachments, 1)
  assert.equal(buttonCleanups, 0)
  assert.equal(count('owner:layout'), 1)
  assert.equal(count('owner:passive'), 1)
  assert.equal(caught.length, scenario === 'boundary-recovery' ? 1 : 0)
  if (scenario === 'boundary-recovery') {
    assert.equal(labelRef.current, null)
    assert.equal(count('label:layout:0'), 0, 'An abandoned render cannot run layout effects')
    assert.equal(count('label:passive:0'), 0, 'An abandoned render cannot run passive effects')
  } else {
    assert(labelRef.current)
    assert.equal(count('label:layout:0'), 1)
    assert.equal(count('label:passive:0'), 1)
  }
  if (terminal) {
    survivor = render(<text text="Survivor ready" style={{ height: 28 }} />, window)
    await bounded(survivor.ready, 'independent survivor root acknowledgement')
  }
  const before = root.diagnostics
  record({ type: 'react-behavior-mounted', diagnostics: before, traces: [...traces] })
  const event = await bounded(activation.promise, 'actual owned OS click')

  if (scenario === 'recoverable-retry' || scenario === 'throwing-reporter') {
    // Run after the native discrete-event wrapper returns: this deliberately
    // exercises an ordinary concurrent update and React's synchronous retry.
    update(1)
    if (scenario === 'throwing-reporter') {
      await assert.rejects(
        bounded(root.flush(), 'terminal reporter flush'),
        (error) => error === originalTerminalError
      )
      await assert.rejects(
        bounded(root.closed, 'terminal reporter disposal'),
        (error) => error === originalTerminalError
      )
      terminalRejected = true
    } else {
      await bounded(root.flush(), 'recovered retry acknowledgement')
      assert.equal(committedValue, 1)
      update(2)
      await bounded(root.flush(), 'post-recovery update acknowledgement')
      assert.equal(committedValue, 2)
      assert.equal(root.diagnostics.mutations.set - before.mutations.set, 2)
    }
    assert(retryAttempts >= 2, 'The failed concurrent attempt must be retried')
    assert.equal(recovered.length, 1)
  } else if (scenario === 'cleanup-effect' || scenario === 'cleanup-ref') {
    await assert.rejects(
      bounded(root.dispose(), 'failing cleanup disposal'),
      (error) => error === originalTerminalError
    )
    await assert.rejects(
      bounded(root.closed, 'failing cleanup closed result'),
      (error) => error === originalTerminalError
    )
    terminalRejected = true
  } else {
    await bounded(root.flush(), 'event update acknowledgement')
    if (scenario === 'transition') {
      transitionAtOrdinaryFlush = committedValue === 1
      await bounded(transitionCommitted.promise, 'explicit transition commit observation')
      await bounded(root.flush(), 'committed transition native acknowledgement')
      assert.equal(committedValue, 1)
      assert.equal(pendingSnapshots.at(-1), false)
    }
  }

  if (terminal) {
    assertReleased()
    assert.equal(application.diagnostics.windows, 1, 'A failed root must not close its window')
    assert.equal(application.diagnostics.callbacks, 0)
    assert.equal(
      application.diagnostics.nodes,
      3,
      'Only the window and independent survivor remain'
    )
    await bounded(
      survivor!.render(<text text={`Survivor after ${scenario}`} style={{ height: 28 }} />),
      'survivor native update'
    )
    assert.equal(survivor!.diagnostics.nodes, 2)
    assert.equal(survivor!.diagnostics.mutations.set, 1)
  } else {
    assert.equal(frameRef.current, frameIdentity)
    assert.equal(buttonAttachments, 1)
    assert.equal(buttonCleanups, 0)
    assert(!event.signal.aborted)
    if (scenario === 'boundary-fallback') {
      assert.equal(caught.length, 1)
      assert.equal(labelRef.current, null)
      assert.equal(count('label:layout-cleanup:0'), 1)
      assert.equal(count('label:passive-cleanup:0'), 1)
    } else if (scenario === 'boundary-recovery') {
      assert.equal(caught.length, 1)
      assert(labelRef.current)
      assert.equal(count('label:layout:1'), 1)
      assert.equal(count('label:passive:1'), 1)
    } else {
      assert.equal(labelRef.current, labelIdentity)
      const value = scenario === 'transition' ? 1 : 2
      assert.equal(count(`label:layout:${value}`), 1)
      assert.equal(count(`label:passive:${value}`), 1)
      assert.equal(count('label:layout-cleanup:0'), 1)
      assert.equal(count('label:passive-cleanup:0'), 1)
      if (scenario !== 'recoverable-retry') {
        assert.equal(root.diagnostics.mutations.set - before.mutations.set, 1)
        assert.equal(count('label:layout:1'), scenario === 'transition' ? 1 : 0)
      }
    }
    if (scenario !== 'recoverable-retry') assert.equal(recovered.length, 0)
  }
  qualified = true
  record({
    type: 'click',
    sequence: event.sequence,
    qualified,
    terminalRejected,
    boundaryErrors: caught.length,
    recoveredErrors: recovered.length,
    transitionAtOrdinaryFlush,
    diagnostics: root.diagnostics,
    survivor: survivor?.diagnostics,
    traces: [...traces],
  })
  await bounded(window.closed, 'actual OS window close')
  record({ type: 'react-behavior-window-closed' })
  if (!terminal) await bounded(root.dispose(), 'OS-close React cleanup')
  await bounded(survivor?.dispose() ?? Promise.resolve(), 'OS-close survivor cleanup')
  record({
    type: 'react-behavior-roots-disposed',
    traces: [...traces],
    diagnostics: root.diagnostics,
  })
  assertReleased()
  record({ type: 'react-behavior-complete', qualified, terminalRejected, traces: [...traces] })
  record({ type: 'closed' })
} catch (error) {
  failure = error
  record({
    type: 'react-behavior-failure',
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
    traces: [...traces],
  })
} finally {
  for (const view of [root, survivor]) {
    if (!view) continue
    try {
      await bounded(view.dispose(), 'final root cleanup')
    } catch (error) {
      if (!(view === root && terminalRejected && error === originalTerminalError)) failure ??= error
    }
  }
  try {
    await application.shutdown()
    await application.closed
    assert(Object.values(application.diagnostics).every((value) => value === 0))
  } catch (error) {
    failure ??= error
  }
  frameIdentity = labelIdentity = null
  hookIdentity = undefined
  const summary = {
    schema: 1,
    scenario,
    status: failure ? 'failed' : 'passed',
    qualified,
    terminalRejected,
    originalTerminalIdentityVerified: terminalRejected,
    boundaryErrors: caught.length,
    recoveredErrors: recovered.length,
    retryAttempts,
    transitionAtOrdinaryFlush,
    pendingSnapshots,
    buttonAttachments,
    buttonCleanups,
    traces,
    diagnostics: root?.diagnostics,
    survivor: survivor?.diagnostics,
    ownership: application.diagnostics,
    failure:
      failure instanceof Error
        ? { name: failure.name, message: failure.message, stack: failure.stack }
        : failure,
  }
  writeFileSync(
    join(dirname(evidencePath), 'react-behavior.json'),
    JSON.stringify(summary, null, 2) + '\n'
  )
  record({ type: 'react-behavior-ownership', ownership: application.diagnostics })
}
if (failure) throw failure
assert(qualified)
