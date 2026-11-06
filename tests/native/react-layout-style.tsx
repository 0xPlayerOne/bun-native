/** @jsxImportSource @bun-native/react */
/** React consumer of the shared layout/style scene; the same elements as core and Solid. */
import { render } from '@bun-native/react'
import { useState } from 'react'
import {
  CONTAINER,
  initialScene,
  INPUT_VALUE,
  LABELS,
  MIN_PANE,
  qualifyLayoutStyle,
  sceneStyles,
  type SceneState,
} from './layout-style-scene.ts'

await qualifyLayoutStyle('react', async (window) => {
  let update!: (state: SceneState) => void
  function App() {
    const [state, setState] = useState(initialScene)
    update = setState
    const style = sceneStyles(state)
    return (
      <box style={style.root}>
        <text text={LABELS.header} style={style.header} />
        <split ratio={state.ratio} min_size={MIN_PANE} style={style.split}>
          <box style={style.paneA}>
            <button text={LABELS.a1} style={style.button} />
            <text text={LABELS.wide} style={style.wide} />
            <box style={style.spacer} />
            <button text={LABELS.a2} style={style.button} />
          </box>
          <box style={style.paneB}>
            <input value={INPUT_VALUE} style={style.input} />
            <button text={LABELS.b1} style={style.accent} />
          </box>
        </split>
        <box style={style.footer}>
          <button text={LABELS.done} style={style.done} />
          <text text={LABELS.status} style={style.status} />
        </box>
      </box>
    )
  }
  const view = render(<App />, window, { style: CONTAINER })
  await view.ready
  return { view, update: (state) => update(state) }
})
