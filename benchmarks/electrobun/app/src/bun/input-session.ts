/** Bounded control state for the optional external visible-input comparison. */
export class InputSession {
  #phase: 'waiting' | 'ready' | 'clicked' | 'finished' | 'failed' = 'waiting'
  #report: Record<string, unknown> | undefined

  constructor(readonly nonce: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce))
      throw new Error('Input comparison requires a random UUID nonce')
  }

  #authorize(nonce: string | null) {
    if (nonce !== this.nonce) throw new Error('Input comparison nonce does not match')
  }

  ready(nonce: string | null, viewport: unknown): [number, number] {
    this.#authorize(nonce)
    if (this.#phase !== 'waiting') throw new Error('Input comparison is not waiting for readiness')
    if (
      !Array.isArray(viewport) ||
      viewport.length !== 2 ||
      !viewport.every((value) => Number.isSafeInteger(value) && value >= 128 && value <= 8192)
    )
      throw new Error('Input comparison requires bounded viewport dimensions')
    this.#phase = 'ready'
    return [viewport[0], viewport[1]]
  }

  clicked(nonce: string | null, report: unknown) {
    this.#authorize(nonce)
    if (this.#phase !== 'ready') {
      this.#phase = 'failed'
      throw new Error('Input comparison requires exactly one click after readiness')
    }
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      this.#phase = 'failed'
      throw new Error('Input click report must be an object')
    }
    const value = report as Record<string, unknown>
    if (value['nonce'] !== this.nonce || value['clicks'] !== 1 || value['label'] !== 'Clicked') {
      this.#phase = 'failed'
      throw new Error('Input click report has unexpected content')
    }
    this.#report = value
    this.#phase = 'clicked'
  }

  finish(nonce: string | null) {
    this.#authorize(nonce)
    if (this.#phase !== 'clicked' || !this.#report)
      throw new Error('Input comparison cannot finish before one click')
    this.#phase = 'finished'
    return this.#report
  }
}

/** The loopback controller may finish only the session that produced the click. */
export async function handleInputRequest(
  session: InputSession,
  request: Request,
  hooks: { ready(viewport: [number, number]): void; finish(report: Record<string, unknown>): void }
): Promise<Response> {
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  const path = new URL(request.url).pathname
  if (request.method !== 'POST') return new Response('not found', { status: 404, headers })
  const nonce = request.headers.get('x-benchmark-nonce')
  try {
    if (path === '/input/ready') {
      const viewport = session.ready(nonce, JSON.parse(await request.text()))
      hooks.ready(viewport)
    } else if (path === '/input/clicked') {
      session.clicked(nonce, JSON.parse(await request.text()))
    } else if (path === '/input/finish') {
      hooks.finish(session.finish(nonce))
    } else return new Response('not found', { status: 404, headers })
    return new Response('ok', { headers })
  } catch (error) {
    return new Response(String(error), { status: 409, headers })
  }
}
