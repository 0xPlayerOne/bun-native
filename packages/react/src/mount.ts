import { NativeStateError, type NativeWindow } from '@bun-native/core'
import { createRenderRoot, type RenderRoot } from '@bun-native/renderer'
import type { ReactNode } from 'react'
import { ConcurrentRoot } from 'react-reconciler/constants'
import { reconciler } from './reconciler.ts'

type FiberRoot = ReturnType<typeof reconciler.createContainer>

export interface ReactRenderRoot extends RenderRoot {
  /** Submit a new React tree; resolves after its native acknowledgement. */
  render(children: ReactNode): Promise<void>
}

class Root implements ReactRenderRoot {
  readonly ready: Promise<void>
  readonly closed: Promise<void>
  private readonly native: RenderRoot
  private fiber!: FiberRoot
  private element: ReactNode
  private phase: 'active' | 'disposing' | 'closed' = 'active'
  private failure: Error | undefined
  private disposal: Promise<void> | undefined
  private readonly barriers = new Set<{ resolve: () => void; reject: (error: unknown) => void }>()

  constructor(children: ReactNode, window: NativeWindow) {
    this.element = children
    this.native = createRenderRoot(window, ({ container, onCleanup, fail }) => {
      this.fiber = reconciler.createContainer(
        container,
        ConcurrentRoot,
        null,
        false,
        null,
        '',
        (error) => {
          this.failure = error instanceof Error ? error : new Error(String(error))
          // React invokes this inside its commit. Teardown must start after that
          // stack returns, rather than recursively entering Fiber's commit.
          queueMicrotask(() => fail(this.failure))
        },
        () => {},
        (error) => {
          this.failure = error instanceof Error ? error : new Error(String(error))
          queueMicrotask(() => fail(this.failure))
        },
        () => {},
        null
      )
      onCleanup(() => {
        this.phase = 'disposing'
        reconciler.updateContainerSync(null, this.fiber, null)
        reconciler.flushSyncWork()
        reconciler.flushPassiveEffects()
      })
      reconciler.updateContainerSync(children, this.fiber, null)
      reconciler.flushSyncWork()
      if (this.failure !== undefined) throw this.failure
      reconciler.flushPassiveEffects()
    })
    this.ready = this.native.ready
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
      const barrier = { resolve, reject }
      this.barriers.add(barrier)
      reconciler.updateContainer(this.element, this.fiber, null, () => {
        this.barriers.delete(barrier)
        resolve()
      })
    })
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
      this.disposal = Promise.resolve().then(() => this.native.dispose())
    }
    return this.disposal
  }
}

/** Mount React into one independently disposable shared native subtree. */
export function render(children: ReactNode, window: NativeWindow): ReactRenderRoot {
  return new Root(children, window)
}
