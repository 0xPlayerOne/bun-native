import { NativeStateError, type NativeWindow, type Style } from '@bun-native/core'
import { createRenderRoot, type RenderOptions, type RenderRoot } from '@bun-native/renderer'
import type { ErrorInfo, ReactNode } from 'react'
import { ConcurrentRoot } from 'react-reconciler/constants'
import { reconciler } from './reconciler.ts'
import { createRootErrors } from './root-errors.ts'
import { createCommitBarrier } from './commit-barrier.ts'

type FiberRoot = ReturnType<typeof reconciler.createContainer>

export interface ReactRenderRoot extends RenderRoot {
  /** Submit a new React tree; resolves after its native acknowledgement. */
  render(children: ReactNode): Promise<void>
}

export interface ReactRenderOptions extends RenderOptions {
  /** Synchronously observe errors React recovered from; defaults to console.error. A thrown reporter error terminates this root. */
  onRecoverableError?: (error: unknown, info: Readonly<ErrorInfo>) => void
}

class Root implements ReactRenderRoot {
  readonly ready: Promise<void>
  readonly closed: Promise<void>
  private readonly native: RenderRoot
  private fiber!: FiberRoot
  private errors: ReturnType<typeof createRootErrors> | undefined
  private element: ReactNode
  private phase: 'active' | 'disposing' | 'closed' = 'active'
  private failure: Error | undefined
  private disposal: Promise<void> | undefined
  private readonly barriers = new Set<ReturnType<typeof createCommitBarrier>>()

  constructor(
    children: ReactNode,
    window: NativeWindow,
    onRecoverableError: NonNullable<ReactRenderOptions['onRecoverableError']>,
    style: Style | undefined
  ) {
    this.element = children
    this.native = createRenderRoot(
      window,
      ({ container, onCleanup, fail }) => {
        const terminate = (error: unknown) => {
          this.failure ??= error instanceof Error ? error : new Error(String(error))
          // React invokes this inside its commit. Teardown must start after that
          // stack returns, rather than recursively entering Fiber's commit.
          queueMicrotask(() => fail(this.failure))
        }
        this.errors = createRootErrors({ terminate, report: onRecoverableError })
        this.fiber = reconciler.createContainer(
          container,
          ConcurrentRoot,
          null,
          false,
          null,
          '',
          this.errors.uncaught,
          this.errors.caught,
          this.errors.recoverable,
          this.errors.transition,
          null
        )
        onCleanup(() => {
          this.phase = 'disposing'
          try {
            reconciler.updateContainerSync(null, this.fiber, null)
            reconciler.flushSyncWork()
            reconciler.flushPassiveEffects()
            // React reports unmount effect/ref errors through onUncaughtError.
            // The shared root is already disposing, so forward the synchronous
            // result here instead of relying on a later terminal-error request.
            if (this.failure) throw this.failure
          } finally {
            // Framework teardown is terminal even while native removal awaits
            // acknowledgement. Keep unmount errors active until this boundary.
            this.errors?.release()
            this.errors = undefined
          }
        })
        reconciler.updateContainerSync(children, this.fiber, null)
        reconciler.flushSyncWork()
        if (this.failure !== undefined) throw this.failure
        reconciler.flushPassiveEffects()
      },
      style === undefined ? {} : { style }
    )
    this.ready = this.native.ready.then(() => {
      if (this.phase !== 'active')
        throw new NativeStateError(
          'invalid_handle',
          'React root closed before initial native acknowledgement'
        )
    })
    void this.ready.catch(() => {})
    this.closed = this.native.closed
    void this.closed.then(
      () => this.finish(),
      (error) => {
        this.failure = error
        this.finish()
      }
    )
  }

  get diagnostics() {
    return this.native.diagnostics
  }

  private finish(): void {
    this.phase = 'closed'
    this.errors?.release()
    this.errors = undefined
    const error = this.failure ?? new NativeStateError('invalid_state', 'React root is closed')
    for (const barrier of this.barriers) barrier.reject(error)
    this.barriers.clear()
    this.element = null
    this.fiber = null
  }

  private assertActive(): void {
    if (this.failure !== undefined) throw this.failure
    if (this.phase !== 'active') throw new NativeStateError('invalid_state', 'React root is closed')
  }

  async render(children: ReactNode): Promise<void> {
    this.assertActive()
    this.element = children
    reconciler.updateContainerSync(children, this.fiber, null)
    reconciler.flushSyncWork()
    await this.flush()
  }

  async flush(): Promise<void> {
    this.assertActive()
    // A normal-priority root update is a Fiber commit barrier for already
    // scheduled ordinary hook updates. It does not wait for future async work,
    // unresolved Suspense, or lower-priority transitions.
    reconciler.flushPassiveEffects()
    await new Promise<void>((resolve, reject) => {
      if (this.barriers.size >= 128) {
        reject(new NativeStateError('limit_exceeded', 'React commit barrier queue is full'))
        return
      }
      const barrier = createCommitBarrier({
        release: () => this.barriers.delete(barrier),
        resolve,
        reject,
      })
      this.barriers.add(barrier)
      try {
        reconciler.updateContainer(this.element, this.fiber, null, barrier.complete)
      } catch (cause) {
        // A rejected submission owns no future commit. Release its capacity and
        // callback bindings now instead of poisoning all later flushes.
        barrier.reject(cause)
      }
    })
    // Native failure cleanup may already have entered disposal. Join it before
    // checking local lifetime so the triggering operation preserves its cause.
    await this.native.flush()
    this.assertActive()
    // Effect code may schedule future work; its mere execution is not evidence
    // that another render is pending. Re-enqueuing barriers until this returns
    // false would itself keep producing commits indefinitely.
    reconciler.flushPassiveEffects()
    await this.native.flush()
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.phase = 'disposing'
      // A listener/layout effect may request disposal. Never reenter Fiber's
      // render or commit from the current application callback stack.
      this.disposal = reconciler.isAlreadyRendering()
        ? Promise.resolve().then(() => this.native.dispose())
        : this.native.dispose()
    }
    return this.disposal
  }
}

/** Mount React into one independently disposable shared native subtree. */
export function render(
  children: ReactNode,
  window: NativeWindow,
  options: ReactRenderOptions = {}
): ReactRenderRoot {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('React render options must be an object')
  for (const name of Object.keys(options))
    if (name !== 'onRecoverableError' && name !== 'style')
      throw new TypeError('Unknown React render option: ' + name)
  const reporter = options.onRecoverableError
  if (reporter !== undefined && typeof reporter !== 'function')
    throw new TypeError('onRecoverableError must be a function')
  return new Root(children, window, reporter ?? console.error, options.style)
}
