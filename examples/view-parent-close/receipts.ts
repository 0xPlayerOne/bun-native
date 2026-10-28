import assert from 'node:assert/strict'
import type { NativeEvent } from '../../packages/runtime/src/native-transport.ts'

export const parentClosePanes = ['first', 'second', 'third', 'fourth'] as const
export type ParentClosePane = (typeof parentClosePanes)[number]
export const parentCloseUrl = (pane: ParentClosePane) => `app://ui/index.html?pane=${pane}`

export interface ParentClosePaneReceipt {
  readonly pane: ParentClosePane
  readonly viewId: string
  readonly sessionId: string
  readonly documentId: string
  readonly nativeTarget: number
  readonly closed: boolean
}

/** Pinned native diagnostic identity, never an application authority token. */
export function parentCloseDocumentTarget(document: string): number {
  const match = /^native-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(document)
  assert.ok(match && match[0] === document && document.length <= 128)
  const target = Number(match[1])
  assert.ok(Number.isSafeInteger(target) && target > 0)
  return target
}

/** Observe actual native callbacks separately from SDK disposal, which can
 * invalidate all child handles when only the parent close reply has arrived.
 */
export class ParentCloseReceipts {
  readonly #loaded = new Map<string, { target: number; document: string }>()
  readonly #panes = new Map<ParentClosePane, ParentClosePaneReceipt>()
  readonly #closed = new Set<number>()
  #closing = false
  #window: number | undefined

  observe(event: NativeEvent): void {
    if (event.event === 'view.loaded') {
      const url = event.data?.['url']
      if (!parentClosePanes.some((pane) => parentCloseUrl(pane) === url)) return
      assert.equal(this.#closing, false, 'Document changed during parent close')
      const document = event.data?.['documentId']
      assert.equal(typeof document, 'string')
      const target = parentCloseDocumentTarget(String(document))
      assert.equal(event.target, target, 'Load receipt targets another native view')
      assert.equal(event.data?.['status'], 200)
      assert.ok(!this.#loaded.has(String(url)), 'Duplicate native document load')
      assert.ok(this.#loaded.size < parentClosePanes.length)
      this.#loaded.set(String(url), { target, document: String(document) })
    } else if (event.event === 'view.closed') {
      assert.equal(this.#closing, true, 'View closed before the parent close request')
      const target = event.target
      assert.ok(
        typeof target === 'number' &&
          [...this.#panes.values()].some((pane) => pane.nativeTarget === target),
        'Unmatched native view close receipt'
      )
      assert.ok(!this.#closed.has(target), 'Duplicate native view close receipt')
      this.#closed.add(target)
    } else if (event.event === 'window.closed') {
      assert.equal(this.#closing, true, 'Window closed before the parent close request')
      assert.equal(this.#window, undefined, 'More than one parent window closed')
      assert.ok(Number.isSafeInteger(event.target) && Number(event.target) > 0)
      assert.ok(
        ![...this.#panes.values()].some((pane) => pane.nativeTarget === event.target),
        'Native window identity aliases a view'
      )
      this.#window = Number(event.target)
    }
  }

  bind(pane: ParentClosePane, viewId: string, sessionId: string, documentId: string): void {
    assert.equal(this.#closing, false)
    assert.ok(!this.#panes.has(pane))
    const loaded = this.#loaded.get(parentCloseUrl(pane))
    assert.ok(loaded, 'Matching native load receipt is required before parent close')
    assert.equal(loaded.document, documentId)
    assert.equal(loaded.target, parentCloseDocumentTarget(documentId))
    for (const previous of this.#panes.values()) {
      assert.notEqual(previous.viewId, viewId)
      assert.notEqual(previous.sessionId, sessionId)
      assert.notEqual(previous.documentId, documentId)
      assert.notEqual(previous.nativeTarget, loaded.target)
    }
    this.#panes.set(pane, {
      pane,
      viewId,
      sessionId,
      documentId,
      nativeTarget: loaded.target,
      closed: false,
    })
  }

  beginClose(): void {
    assert.equal(this.#closing, false)
    assert.equal(this.#panes.size, parentClosePanes.length)
    assert.equal(this.#loaded.size, parentClosePanes.length)
    assert.equal(this.#closed.size, 0)
    assert.equal(this.#window, undefined)
    this.#closing = true
  }

  complete(): boolean {
    return (
      this.#closing && this.#closed.size === parentClosePanes.length && this.#window !== undefined
    )
  }

  snapshot() {
    return {
      panes: parentClosePanes.flatMap((pane) => {
        const value = this.#panes.get(pane)
        return value ? [{ ...value, closed: this.#closed.has(value.nativeTarget) }] : []
      }),
      nativeWindowTarget: this.#window ?? null,
      nativeViewCloseCallbacks: this.#closed.size,
      nativeWindowCloseCallbacks: this.#window === undefined ? 0 : 1,
    }
  }
}
