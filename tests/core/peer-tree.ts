// Minimal state for deterministic subprocess fixtures. Native validation and
// rendering are tested independently; this helper only gives emitted events
// the ancestry/revision produced by each fixture's already-parsed commands.
import type { Element, Operation } from '@bun-native/protocol'

export type PeerNode = {
  element: Element
  inputRevision: number
  parent?: number
  children: number[]
}

export class PeerTree {
  readonly nodes = new Map<number, PeerNode>()
  revision = 0

  constructor(readonly rootId: number) {
    this.nodes.set(rootId, { element: { kind: 'box' }, inputRevision: 0, children: [] })
  }

  route(node_id: number, tree_revision = this.revision) {
    const path = [node_id]
    let node = this.nodes.get(node_id)
    if (!node) throw new Error('Fixture event has no target')
    while (node.parent !== undefined) {
      path.unshift(node.parent)
      node = this.nodes.get(node.parent)!
    }
    if (path[0] !== this.rootId) throw new Error('Fixture event target is detached')
    return { node_id, tree_revision, path }
  }

  apply(operations: readonly Operation[]): void {
    for (const operation of operations) {
      if (operation.type === 'create')
        this.nodes.set(operation.node_id, {
          element: operation.element,
          inputRevision: 0,
          children: [],
        })
      else if (operation.type === 'set') {
        const node = this.nodes.get(operation.node_id)!
        node.element = operation.element
        if (operation.element.kind === 'input') node.inputRevision++
      } else if (operation.type === 'insert') {
        const node = this.nodes.get(operation.child_id)!
        if (node.parent !== undefined) {
          const siblings = this.nodes.get(node.parent)!.children
          siblings.splice(siblings.indexOf(operation.child_id), 1)
        }
        node.parent = operation.parent_id
        this.nodes.get(operation.parent_id)!.children.splice(operation.index, 0, operation.child_id)
      } else {
        const remove = (id: number) => {
          const node = this.nodes.get(id)!
          for (const child of node.children) remove(child)
          this.nodes.delete(id)
        }
        const node = this.nodes.get(operation.node_id)!
        if (node.parent !== undefined) {
          const siblings = this.nodes.get(node.parent)!.children
          siblings.splice(siblings.indexOf(operation.node_id), 1)
        }
        remove(operation.node_id)
      }
    }
    this.revision++
  }
}
