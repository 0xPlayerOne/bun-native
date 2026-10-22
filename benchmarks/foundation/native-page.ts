/** Controlled renderer workload. Synthetic DOM input is explicitly not hardware input. */
import { encodeNativeTitle } from './native-wire.ts'
declare const PROFILE_ASSET_BYTES: number
declare const PROFILE_ASSET_SHA256: string
const samples = 32
const input = document.querySelector<HTMLInputElement>('#profile-input')!
let inputEvents = 0
const onInput = () => {
  inputEvents++
}
input.addEventListener('input', onInput)
const rounded = (value: number) => Math.round(value * 1000) / 1000
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))

async function probe(background?: () => boolean) {
  const inputToFrameMs: number[] = [],
    frameIntervalsMs: number[] = []
  let backgroundSamples = 0
  let previous = await frame()
  for (let index = 0; index < samples; index++) {
    const started = performance.now()
    const queuedWithWork = background?.() ?? false
    const painted = await new Promise<number>((resolve) => {
      setTimeout(() => {
        input.value = String(index)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        requestAnimationFrame(resolve)
      }, 0)
    })
    if (queuedWithWork && background?.()) backgroundSamples++
    inputToFrameMs.push(rounded(performance.now() - started))
    frameIntervalsMs.push(rounded(painted - previous))
    previous = painted
  }
  return { inputToFrameMs, frameIntervalsMs, backgroundSamples }
}

async function main() {
  await frame()
  document.title = 'bunly.foundation:' + JSON.stringify({ kind: 'ready' })
  const idle = await probe()
  const counts = { full: 0, range: 0, head: 0, conditional: 0 }
  const requestMs = {
    full: [] as number[],
    range: [] as number[],
    head: [] as number[],
    conditional: [] as number[],
  }
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 10000)
  let running = true
  let activeRequests = 0
  async function fetchAsset(kind: keyof typeof counts, round: number) {
    const headers: Record<string, string> = {}
    if (kind === 'range') headers['Range'] = 'bytes=128-4223'
    if (kind === 'conditional') headers['If-None-Match'] = '"' + PROFILE_ASSET_SHA256 + '"'
    activeRequests++
    let stage = 'fetch'
    try {
      const response = await fetch('/asset.bin?kind=' + kind + '&round=' + round, {
        method: kind === 'head' ? 'HEAD' : 'GET',
        cache: 'no-store',
        headers,
        signal: controller.signal,
      })
      stage = 'headers'
      const expectedStatus = kind === 'conditional' ? 304 : kind === 'range' ? 206 : 200
      if (response.status !== expectedStatus)
        throw new Error('Unexpected asset status: ' + kind + '/' + response.status)
      if (response.headers.get('ETag') !== '"' + PROFILE_ASSET_SHA256 + '"')
        throw new Error('Asset validator changed')
      stage = 'body'
      const body = new Uint8Array(await response.arrayBuffer())
      stage = 'length'
      const expectedBytes = kind === 'full' ? PROFILE_ASSET_BYTES : kind === 'range' ? 4096 : 0
      if (body.length !== expectedBytes) throw new Error('Unexpected retained response bytes')
      return body
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.name + ': ' + error.message : String(error)
      throw new Error(
        'Asset ' + kind + ' round=' + round + ' stage=' + stage + ': ' + detail.slice(0, 160)
      )
    } finally {
      activeRequests--
    }
  }
  async function load(kind: keyof typeof counts) {
    for (let round = 0; running && round < 64; round++) {
      const started = performance.now()
      const body = await fetchAsset(kind, round)
      if (kind === 'full') {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body))
        const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
        if (hex !== PROFILE_ASSET_SHA256) throw new Error('Asset content differs')
      } else if (kind === 'range' && body.some((byte) => byte !== 81))
        throw new Error('Range content differs')
      counts[kind]++
      requestMs[kind].push(rounded(performance.now() - started))
    }
  }
  const activeStarted = performance.now()
  const loads = Promise.all((['full', 'range', 'head', 'conditional'] as const).map(load))
  void loads.catch(() => {})
  let active: Awaited<ReturnType<typeof probe>>
  try {
    active = await probe(() => activeRequests > 0)
    running = false
    await loads
  } finally {
    running = false
    controller.abort()
    clearTimeout(deadline)
  }
  if (
    Object.values(counts).some((count) => count < 1) ||
    inputEvents !== samples * 2 ||
    active.backgroundSamples !== samples
  )
    throw new Error('Incomplete concurrent load or input workload')
  input.removeEventListener('input', onInput)
  document.title = encodeNativeTitle({
    kind: 'result',
    schema: 1,
    samples,
    idle,
    active,
    counts,
    requestMs,
    activeElapsedMs: rounded(performance.now() - activeStarted),
    syntheticInputEvents: inputEvents,
  })
}
void main().catch((error: unknown) => {
  input.removeEventListener('input', onInput)
  document.title =
    'bunly.foundation:' +
    JSON.stringify({
      kind: 'failure',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 256),
    })
})
