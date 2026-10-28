import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { downloadFixturePayloads } from './contract.ts'

export function payload(bytes: number, seed: number): Buffer {
  return Buffer.from(Uint8Array.from({ length: bytes }, (_, index) => (index * 17 + seed) % 251))
}

/** Private, finite fixture servers. All transfer bytes still flow through CEF. */
export async function downloadFixtureServer(assets: { html: string; client: string }) {
  const counts = new Map<string, number>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const reloads = new Set<ServerResponse>()
  let reloadReady!: () => void
  const reloadRequested = new Promise<void>((resolve) => {
    reloadReady = resolve
  })
  let blockedRequests = 0,
    requestCount = 0,
    activeStreams = 0,
    cancelledStreams = 0,
    reloadReleased = false
  const small = payload(downloadFixturePayloads.small.bytes, downloadFixturePayloads.small.seed)
  const large = payload(downloadFixturePayloads.large.bytes, downloadFixturePayloads.large.seed)
  const chunk = payload(32 * 1024, 37)
  const blocked = createServer((_request, response) => {
    blockedRequests++
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    response.end('This response must never be requested by CEF')
  })
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  const blockedOrigin = await listen(blocked)
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (++requestCount > 256 || request.method !== 'GET') {
      response.writeHead(429)
      response.end()
      return
    }
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1)
    response.setHeader('Cache-Control', 'no-store')
    if (url.pathname === '/document') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(assets.html)
    } else if (url.pathname === '/client.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      response.end(assets.client)
    } else if (url.pathname === '/reload-command') {
      if (reloadReleased) response.end('done')
      else {
        reloads.add(response)
        reloadReady()
        response.once('close', () => reloads.delete(response))
      }
    } else if (url.pathname === '/redirect.bin' || url.pathname === '/redirect-denied.bin') {
      response.writeHead(302, {
        Location:
          url.pathname === '/redirect.bin' ? '/small.bin' : blockedOrigin + '/forbidden.bin',
      })
      response.end()
    } else if (url.pathname === '/small.bin' || url.pathname === '/large.bin') {
      const body = url.pathname === '/small.bin' ? small : large
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        // Destination selection must ignore this untrusted suggestion entirely.
        'Content-Disposition': 'attachment; filename="../../outside-fixture.txt"',
      })
      response.end(body)
    } else if (url.pathname === '/broken.bin') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': 1024 * 1024,
      })
      response.write(chunk)
      const timer = setTimeout(() => response.destroy(), 30)
      response.once('close', () => clearTimeout(timer))
    } else if (url.pathname === '/slow.bin' || url.pathname === '/unknown-size.bin') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        ...(url.pathname === '/slow.bin' ? { 'Content-Length': chunk.length * 128 } : {}),
      })
      activeStreams++
      let pieces = 0,
        finished = false
      const timer = setInterval(() => {
        if (response.writableNeedDrain === false) {
          pieces++
          response.write(chunk)
          if (pieces === 128) {
            finished = true
            clearInterval(timer)
            timers.delete(timer)
            response.end()
          }
        }
      }, 30)
      timers.add(timer)
      response.once('close', () => {
        clearInterval(timer)
        timers.delete(timer)
        activeStreams--
        if (!finished) cancelledStreams++
      })
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  let origin: string
  try {
    origin = await listen(server)
  } catch (error) {
    blocked.closeAllConnections()
    blocked.close()
    throw error
  }
  return {
    origin,
    blockedOrigin,
    small,
    large,
    count: (path: string) => counts.get(path) ?? 0,
    reloadRequested,
    releaseReload: () => {
      reloadReleased = true
      for (const response of reloads) response.end('reload')
      reloads.clear()
    },
    observations: () => ({ requestCount, blockedRequests, activeStreams, cancelledStreams }),
    close: async () => {
      for (const timer of timers) clearInterval(timer)
      timers.clear()
      for (const response of reloads) response.end('done')
      reloads.clear()
      await Promise.all(
        [server, blocked].map(async (item) => {
          item.closeAllConnections()
          await new Promise<void>((resolve, reject) =>
            item.close((error) => (error ? reject(error) : resolve()))
          )
        })
      )
    },
  }
}
