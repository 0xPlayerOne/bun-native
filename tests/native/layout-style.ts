/** Public-core consumer of the shared layout/style scene. */
import type { Element, NativeBatch, NativeNode } from '@bun-native/core'
import {
  CONTAINER,
  INPUT_VALUE,
  LABELS,
  MIN_PANE,
  qualifyLayoutStyle,
  sceneStyles,
  type SceneState,
} from './layout-style-scene.ts'

function elements(state: SceneState) {
  const style = sceneStyles(state)
  const button = (text: string, buttonStyle = style.button) =>
    ({ kind: 'button', text, style: buttonStyle }) as const
  return {
    // The renderer adapters' ownership container, created by render(..., { style: CONTAINER }).
    container: { kind: 'box', style: CONTAINER },
    root: { kind: 'box', style: style.root },
    header: { kind: 'text', text: LABELS.header, style: style.header },
    split: { kind: 'split', ratio: state.ratio, min_size: MIN_PANE, style: style.split },
    paneA: { kind: 'box', style: style.paneA },
    a1: button(LABELS.a1),
    wide: { kind: 'text', text: LABELS.wide, style: style.wide },
    spacer: { kind: 'box', style: style.spacer },
    a2: button(LABELS.a2),
    paneB: { kind: 'box', style: style.paneB },
    input: { kind: 'input', value: INPUT_VALUE, style: style.input },
    b1: button(LABELS.b1, style.accent),
    footer: { kind: 'box', style: style.footer },
    done: button(LABELS.done, style.done),
    status: { kind: 'text', text: LABELS.status, style: style.status },
  } as const satisfies Record<string, Element>
}
type Name = keyof ReturnType<typeof elements>
const tree: [Name | 'window', Name[]][] = [
  ['window', ['container']],
  ['container', ['root']],
  ['root', ['header', 'split', 'footer']],
  ['split', ['paneA', 'paneB']],
  ['paneA', ['a1', 'wide', 'spacer', 'a2']],
  ['paneB', ['input', 'b1']],
  ['footer', ['done', 'status']],
]

await qualifyLayoutStyle('core', async (window) => {
  const initial = elements({ theme: 'light', ratio: 0.5 })
  const nodes = await window.batch((batch) => {
    const created = {} as Record<Name, NativeNode>
    for (const name of Object.keys(initial) as Name[]) created[name] = batch.create(initial[name])
    for (const [parent, children] of tree)
      for (const child of children)
        batch.append(
          (parent === 'window' ? window.root : created[parent]) as NativeNode<'box'>,
          created[child]
        )
    return created
  })
  return {
    update: (state) =>
      window.batch((batch: NativeBatch) => {
        const next = elements(state)
        for (const name of Object.keys(next) as Name[]) {
          const element = next[name]
          if (element.kind === 'input') {
            const input = nodes[name] as NativeNode<'input'>
            batch.set(input, element, window.input(input).revision)
          } else batch.set(nodes[name] as never, element as never)
        }
      }),
  }
})
