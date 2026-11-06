import type { Element, NativeBatch, NativeNode, NativeWindow } from '@bun-native/core'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Evidence = { type: string } & Record<string, unknown>

/**
 * Run with the examples' opt-in evidence log enabled, exposing the records
 * written so far. Handlers record evidence only after their own checks pass.
 */
export async function withEvidence(run: (evidence: () => Evidence[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-example-evidence-'))
  const path = join(directory, 'evidence.jsonl')
  const nonce = crypto.randomUUID()
  const previous = [
    process.env['BUN_NATIVE_EVIDENCE_LOG'],
    process.env['BUN_NATIVE_EVIDENCE_NONCE'],
  ]
  process.env['BUN_NATIVE_EVIDENCE_LOG'] = path
  process.env['BUN_NATIVE_EVIDENCE_NONCE'] = nonce
  const evidence = () =>
    (existsSync(path) ? readFileSync(path, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Evidence & { nonce: string })
      .filter((entry) => entry.nonce === nonce)
  try {
    await run(evidence)
  } finally {
    restore('BUN_NATIVE_EVIDENCE_LOG', previous[0])
    restore('BUN_NATIVE_EVIDENCE_NONCE', previous[1])
    await rm(directory, { recursive: true, force: true })
  }
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

type Synchronous<T> = T & (T extends PromiseLike<unknown> ? never : unknown)
type Mirrored = { element: Element | undefined; parent?: NativeNode; children: NativeNode[] }

/**
 * Mirror the public batch calls an example makes against a headless peer. Only
 * acknowledged batches are applied, so the mirror is the committed native tree
 * the peer received; it makes no rendering or layout claim.
 */
export function mirrorWindow(actual: NativeWindow) {
  const nodes = new Map<NativeNode, Mirrored>([[actual.root, { element: undefined, children: [] }]])
  const detach = (node: NativeNode) => {
    const entry = nodes.get(node)!
    if (entry.parent) {
      const siblings = nodes.get(entry.parent)!.children
      siblings.splice(siblings.indexOf(node), 1)
    }
    delete entry.parent
  }
  const insert = (parent: NativeNode, child: NativeNode, index: number) => {
    detach(child)
    nodes.get(parent)!.children.splice(index, 0, child)
    nodes.get(child)!.parent = parent
  }
  const drop = (node: NativeNode) => {
    for (const child of nodes.get(node)!.children) drop(child)
    nodes.delete(node)
  }
  const window: NativeWindow = {
    root: actual.root,
    get closed() {
      return actual.closed
    },
    get revision() {
      return actual.revision
    },
    batch: mirroredBatch,
    close: actual.close.bind(actual),
    displaySnapshot: actual.displaySnapshot.bind(actual),
    openFileGrant: actual.openFileGrant.bind(actual),
    readClipboardText: actual.readClipboardText.bind(actual),
    writeClipboardText: actual.writeClipboardText.bind(actual),
    registerGlobalShortcut: actual.registerGlobalShortcut.bind(actual),
    postNotification: actual.postNotification.bind(actual),
    input: actual.input.bind(actual),
    on: actual.on.bind(actual),
    onClick: actual.onClick.bind(actual),
    onInput: actual.onInput.bind(actual),
  }
  async function mirroredBatch<T>(update: (batch: NativeBatch) => Synchronous<T>): Promise<T> {
    const pending: (() => void)[] = []
    const result = await actual.batch<T>((batch) =>
      update({
        create(element) {
          const node = batch.create(element)
          pending.push(() => nodes.set(node, { element, children: [] }))
          return node
        },
        set(node: NativeNode, element: Element, revision?: number) {
          ;(batch.set as (...args: unknown[]) => void)(node, element, revision)
          pending.push(() => {
            nodes.get(node)!.element = element
          })
        },
        insert(parent, child, index) {
          batch.insert(parent, child, index)
          pending.push(() => insert(parent, child, index))
        },
        append(parent, child) {
          batch.append(parent, child)
          pending.push(() => {
            if (nodes.get(child)!.parent === parent) detach(child)
            insert(parent, child, nodes.get(parent)!.children.length)
          })
        },
        remove(node) {
          batch.remove(node)
          pending.push(() => {
            detach(node)
            drop(node)
          })
        },
      } as NativeBatch)
    )
    for (const apply of pending) apply()
    return result
  }
  /** Committed subtree below the window root as `kind:label` lines. */
  function tree(node: NativeNode = actual.root, depth = 0): string[] {
    const lines: string[] = []
    for (const child of nodes.get(node)!.children) {
      const element = nodes.get(child)!.element!
      const label =
        element.kind === 'text' || element.kind === 'button'
          ? `${element.kind}:${element.text}`
          : element.kind === 'input'
            ? `input:${element.value}|${element.placeholder ?? ''}`
            : element.kind
      lines.push('  '.repeat(depth) + label, ...tree(child, depth + 1))
    }
    return lines
  }
  return { window, tree, size: () => nodes.size - 1 }
}
