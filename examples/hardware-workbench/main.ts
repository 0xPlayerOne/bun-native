import { fileURLToPath } from 'node:url'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { workbenchSchema } from './contract.ts'
import { HardwareWorkbench } from './controller.ts'
import { startPreviewServer } from './server.ts'

/** Interactive application. No elapsed-time exit or automatic qualification result. */
export default async function hardwareWorkbench(backend: CefBackend): Promise<void> {
  const fixtures = await startPreviewServer(fileURLToPath(new URL('../public/', import.meta.url)))
  const app = new HardwareWorkbench(backend, fixtures.origin)
  let stopRpc = () => {}
  let closed = false
  try {
    stopRpc = backend.serveRpc(
      workbenchSchema,
      {
        snapshot: {
          capability: 'hardware-workbench',
          handle: (_input, context) => app.snapshot(context),
        },
        command: {
          capability: 'hardware-workbench',
          handle: (input, context) => app.command(input, context),
        },
      },
      ['app://ui'],
      ['hardware-workbench']
    )
    await app.start()
    console.log(
      JSON.stringify({
        event: 'bunly.workbench.ready',
        profile: 'native-hardware-workbench-v1',
        bun: Bun.version,
        hardwareQualified: false,
        manualResults: 'not-recorded',
      })
    )
    await backend.closed
    closed = true
  } finally {
    app.stop()
    stopRpc()
    await fixtures.close()
    console.log(
      JSON.stringify({
        event: 'bunly.workbench.backend-ended',
        closed,
        hardwareQualified: false,
        processCleanupQualified: false,
      })
    )
  }
}
