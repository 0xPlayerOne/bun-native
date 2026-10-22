import type { IncomingMessage, ServerResponse } from 'node:http'
export interface CompletionOptions {
  readonly token: string
  readonly scenario: string
  readonly timeoutMs?: number
}
/** Completion-only channel for trusted synthetic fixtures. It exposes no native operations. */
export function completionChannel(options: CompletionOptions) {
  const timeoutMs = options.timeoutMs ?? 22000
  if (
    !/^[a-f0-9]{48}$/.test(options.token) ||
    !/^[a-z][a-z-]{0,48}$/.test(options.scenario) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    throw new Error('Invalid completion channel')
  let result: Record<string, unknown> | undefined
  let waiting = false
  let deliver: (() => void) | undefined
  const respond = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(value))
  }
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    signal: AbortSignal
  ): Promise<boolean> => {
    if (url.pathname !== '/__benchmark/completion') return false
    if (request.headers['x-benchmark-token'] !== options.token) {
      respond(response, 403, { error: 'DENIED' })
      return true
    }
    if (request.method === 'POST') {
      if (request.headers.origin !== url.origin) {
        respond(response, 403, { error: 'ORIGIN_REQUIRED' })
        return true
      }
      if (result) {
        respond(response, 409, { error: 'ALREADY_COMPLETED' })
        return true
      }
      if (Number(request.headers['content-length'] ?? 0) > 65536) {
        request.resume()
        respond(response, 413, { error: 'TOO_LARGE' })
        return true
      }
      try {
        let length = 0
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk)
          length += bytes.length
          if (length > 65536) throw new Error('Completion limit')
          chunks.push(bytes)
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid completion')
        const record = value as Record<string, unknown>
        if (record['scenario'] !== options.scenario || typeof record['passed'] !== 'boolean')
          throw new Error('Mismatched completion')
        if (result) {
          respond(response, 409, { error: 'ALREADY_COMPLETED' })
          return true
        }
        result = record
        respond(response, 202, { accepted: true })
        deliver?.()
      } catch {
        if (!response.destroyed) respond(response, 400, { error: 'INVALID_COMPLETION' })
      }
      return true
    }
    if (request.method !== 'GET') {
      respond(response, 405, { error: 'METHOD_DENIED' })
      return true
    }
    if (waiting) {
      respond(response, 409, { error: 'WAITER_EXISTS' })
      return true
    }
    waiting = true
    try {
      if (!result)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error('Completion timeout')), timeoutMs)
          function finish(error?: Error): void {
            clearTimeout(timer)
            signal.removeEventListener('abort', aborted)
            deliver = undefined
            if (error) reject(error)
            else resolve()
          }
          const aborted = () => finish(new Error('Completion cancelled'))
          deliver = () => finish()
          signal.addEventListener('abort', aborted, { once: true })
          if (signal.aborted) aborted()
        })
      if (!response.destroyed) respond(response, 200, result)
    } catch {
      if (!response.destroyed) respond(response, 408, { error: 'COMPLETION_UNAVAILABLE' })
    } finally {
      waiting = false
    }
    return true
  }
}
