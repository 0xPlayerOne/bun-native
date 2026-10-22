import { MockBackend, defineApp, startApp } from '../../packages/runtime/src/index.ts'
const backend = new MockBackend()
const events: string[] = []
const unsubscribe = backend.onEvent((event) => events.push(event.type))
const app = await startApp(
  backend,
  defineApp({
    id: 'dev.bunly.workbench',
    title: 'Bunly contract workbench',
    url: 'https://example.test',
  })
)
await backend.navigate(app.view, 'https://example.test/next')
await app.dispose()
unsubscribe()
console.log(
  JSON.stringify(
    { implementation: 'mock (no native UI)', events, diagnostics: backend.diagnostics() },
    null,
    2
  )
)
await backend.dispose()
