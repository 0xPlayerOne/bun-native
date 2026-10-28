import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface FixtureAsset {
  readonly body: Uint8Array
  readonly type: string
}

/** Fixed read-only fixture routes. No generic file server, redirects or command endpoint. */
export function previewResponse(
  request: Request,
  origin: string,
  assets: ReadonlyMap<string, FixtureAsset>
): Response {
  const url = new URL(request.url)
  if (
    url.origin !== origin ||
    request.headers.get('host') !== new URL(origin).host ||
    url.search ||
    (request.method !== 'GET' && request.method !== 'HEAD')
  )
    return new Response('Denied', { status: 403 })
  const asset = assets.get(url.pathname)
  if (!asset) return new Response('Not found', { status: 404 })
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(asset.body).buffer, {
    headers: {
      'Content-Type': asset.type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    },
  })
}

export async function startPreviewServer(publicRoot: string) {
  const assets = new Map<string, FixtureAsset>()
  for (const [filename, type] of [
    ['preview.html', 'text/html; charset=utf-8'],
    ['page.js', 'text/javascript; charset=utf-8'],
    ['workbench.css', 'text/css; charset=utf-8'],
  ] as const) {
    const body = await readFile(join(publicRoot, filename))
    if (body.byteLength === 0 || body.byteLength > 1024 * 1024)
      throw new Error('Invalid fixture asset size')
    for (const path of filename === 'preview.html'
      ? ['/left.html', '/right.html']
      : [`/${filename}`])
      assets.set(path, { body, type })
  }
  let origin = ''
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 1024,
    fetch: (request) => previewResponse(request, origin, assets),
  })
  origin = `http://127.0.0.1:${server.port}`
  return { origin, close: () => server.stop(true) }
}
