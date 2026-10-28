import type { InputAction, OperationOptions, ViewHandle } from './index.ts'

/** Development-only browser control. These limits apply before native admission. */
export const BROWSER_ACTION_LIMITS = Object.freeze({
  operations: 8,
  operationsPerView: 1,
  ownedBytes: 8 * 1024 * 1024,
  screenshotBytes: 1024 * 1024,
  screenshotWidth: 1024,
  screenshotHeight: 768,
  resultBytes: 256 * 1024,
  nodes: 256,
  depth: 4,
  textCharacters: 512,
  expressionBytes: 4096,
  inputBytes: 4096,
  evaluationTimeoutMs: 1000,
  operationTimeoutMs: 8000,
} as const)

export interface ScreenshotOptions extends OperationOptions {
  /** Top-left viewport crop, in output pixels; never a full-page capture. */
  readonly maxWidth?: number
  readonly maxHeight?: number
}
export interface BrowserScreenshot {
  readonly format: 'png'
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}
export interface BrowserObservationNode {
  readonly id: number
  readonly parent?: number
  readonly depth: number
  readonly role: string
  readonly name: string
  readonly text: string
}
export interface BrowserObservation {
  readonly kind: 'dom' | 'accessibility'
  readonly nodes: readonly BrowserObservationNode[]
  readonly truncated: boolean
}
/** Optional capability surface. Remote documents retain normal browser origins. */
export interface BrowserActionsBackend {
  captureScreenshot(view: ViewHandle, options?: ScreenshotOptions): Promise<BrowserScreenshot>
  observeDom(view: ViewHandle, options?: OperationOptions): Promise<BrowserObservation>
  accessibilityTree(view: ViewHandle, options?: OperationOptions): Promise<BrowserObservation>
  /** Exact source must have a current native browser-evaluate grant. */
  evaluate(view: ViewHandle, expression: string, options?: OperationOptions): Promise<unknown>
  /** Synthetic DOM dispatch only. Does not generate trusted or hardware input. */
  input(view: ViewHandle, action: InputAction, options?: OperationOptions): Promise<void>
}
