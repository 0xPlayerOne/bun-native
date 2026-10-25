import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'

function fixtureChunk(stream: number, sequence: number, bytes: number): Uint8Array {
  const chunk = new Uint8Array(bytes)
  for (let index = 0; index < chunk.length; index++)
    chunk[index] = (stream * 61 + sequence * 17 + index * 13) & 0xff
  return chunk
}
function digest(chunks: readonly Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const chunk of chunks) hash.update(chunk)
  return hash.digest('hex')
}

export function serveStreamFixture(backend: CefBackend) {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const completed = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  void completed.catch(() => {})
  let fixtureSelected = false
  const stop = backend.serveStreams(['app://ui'], (connection) => {
    const sender = connection.sender()
    // The application creates other trusted views during lifecycle qualification.
    // They receive their own bounded lane but cannot replay the one fixture workload.
    if (fixtureSelected) return
    fixtureSelected = true
    void (async () => {
      const alphaChunks = [fixtureChunk(1, 1, 16 * 1024), fixtureChunk(1, 2, 777)]
      const betaChunks = [fixtureChunk(2, 1, 4096), fixtureChunk(2, 2, 8192)]
      const alpha = await sender.open('alpha')
      const beta = await sender.open('beta')
      for (let index = 0; index < 2; index++) {
        await alpha.write(alphaChunks[index]!)
        await beta.write(betaChunks[index]!)
      }
      await alpha.end()
      await beta.end()

      const cancelled = await sender.open('cancel')
      const pending = cancelled.write(fixtureChunk(3, 1, 1024))
      void pending.catch(() => {})
      // FIFO completion proves the preceding native DATA command reached CEF;
      // it is deliberately not renderer-consumption acknowledgement.
      await backend.nativeDiagnostics()
      cancelled.cancel()
      await assert.rejects(pending, { code: 'CANCELLED' })
      assert.deepEqual(await cancelled.finished, { ok: false, code: 'CANCELLED' })
      const retiring = await sender.open('retire')
      await assert.rejects(retiring.write(new Uint8Array([7])))
      await sender.closed
      assert.equal(connection.signal.aborted, true)
      resolve({
        schema: 1,
        alpha: {
          chunks: alphaChunks.length,
          bytes: alphaChunks.reduce((total, chunk) => total + chunk.byteLength, 0),
          sha256: digest(alphaChunks),
        },
        beta: {
          chunks: betaChunks.length,
          bytes: betaChunks.reduce((total, chunk) => total + chunk.byteLength, 0),
          sha256: digest(betaChunks),
        },
        cancellation: 'producer-cancelled',
        laneRetired: true,
      })
    })().catch(reject)
  })
  return Object.freeze({ completed, stop })
}
