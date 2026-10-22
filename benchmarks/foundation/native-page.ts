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

/** Real CEF response semantics, deliberately outside the measured interaction phase. */
async function checkAssetSemantics() {
  const bytes = PROFILE_ASSET_BYTES,
    tag = '"' + PROFILE_ASSET_SHA256 + '"'
  const selected = 'bytes 128-4223/' + bytes
  const tail = 'bytes ' + (bytes - 4096) + '-' + (bytes - 1) + '/' + bytes
  const cases: {
    name: string
    method?: 'HEAD'
    headers: Record<string, string>
    status: number
    length: number | null
    range: string | null
    bodyBytes: number
  }[] = [
    {
      name: 'nonzero-range',
      headers: { Range: 'bytes=128-4223' },
      status: 206,
      length: 4096,
      range: selected,
      bodyBytes: 4096,
    },
    {
      name: 'clipped-range',
      headers: { Range: 'bytes=' + (bytes - 4096) + '-' + (bytes + 4096) },
      status: 206,
      length: 4096,
      range: tail,
      bodyBytes: 4096,
    },
    {
      name: 'suffix-range',
      headers: { Range: 'bytes=-4096' },
      status: 206,
      length: 4096,
      range: tail,
      bodyBytes: 4096,
    },
    {
      name: 'unsatisfiable-range',
      headers: { Range: 'bytes=' + bytes + '-' },
      status: 416,
      length: 0,
      range: 'bytes */' + bytes,
      bodyBytes: 0,
    },
    {
      name: 'multiple-ranges',
      headers: { Range: 'bytes=0-1,4-5' },
      status: 200,
      length: bytes,
      range: null,
      bodyBytes: bytes,
    },
    {
      name: 'matching-if-range',
      headers: { Range: 'bytes=128-4223', 'If-Range': tag },
      status: 206,
      length: 4096,
      range: selected,
      bodyBytes: 4096,
    },
    {
      name: 'mismatched-if-range',
      headers: { Range: 'bytes=128-4223', 'If-Range': '"fixture-mismatched-validator"' },
      status: 200,
      length: bytes,
      range: null,
      bodyBytes: bytes,
    },
    {
      name: 'head-with-range',
      method: 'HEAD',
      headers: { Range: 'bytes=128-4223' },
      status: 200,
      length: bytes,
      range: null,
      bodyBytes: 0,
    },
    {
      name: 'conditional-with-range',
      headers: { Range: 'bytes=128-4223', 'If-None-Match': tag },
      status: 304,
      length: null,
      range: null,
      bodyBytes: 0,
    },
  ]
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 5000)
  let completed = 0
  try {
    for (const item of cases) {
      let stage = 'fetch'
      try {
        const response = await fetch('/asset.bin?semantic=' + item.name, {
          method: item.method ?? 'GET',
          headers: item.headers,
          cache: 'no-store',
          signal: controller.signal,
        })
        stage = 'headers'
        if (response.status !== item.status)
          throw new Error('Status ' + response.status + ', expected ' + item.status)
        for (const [header, expected] of [
          ['Content-Length', item.length === null ? null : String(item.length)],
          ['Content-Range', item.range],
          ['ETag', item.status === 416 ? null : tag],
        ] as const) {
          const actual = response.headers.get(header)
          if (actual !== expected)
            throw new Error(header + ' ' + String(actual) + ', expected ' + String(expected))
        }
        stage = 'body'
        const body = new Uint8Array(await response.arrayBuffer())
        if (body.length !== item.bodyBytes || body.some((byte) => byte !== 81))
          throw new Error('Body bytes differ')
        completed++
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.name + ': ' + error.message : String(error)
        throw new Error(
          'Asset semantics ' + item.name + ' stage=' + stage + ': ' + detail.slice(0, 160)
        )
      }
    }
  } finally {
    controller.abort()
    clearTimeout(deadline)
  }
  return completed
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
      const expectedLength =
        kind === 'conditional' ? null : String(kind === 'range' ? 4096 : PROFILE_ASSET_BYTES)
      const expectedRange = kind === 'range' ? 'bytes 128-4223/' + PROFILE_ASSET_BYTES : null
      if (
        response.headers.get('Content-Length') !== expectedLength ||
        response.headers.get('Content-Range') !== expectedRange
      )
        throw new Error('Unexpected asset representation headers')
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
  const activeElapsedMs = rounded(performance.now() - activeStarted)
  const assetSemantics = await checkAssetSemantics()
  input.removeEventListener('input', onInput)
  document.title = encodeNativeTitle({
    kind: 'result',
    schema: 1,
    samples,
    idle,
    active,
    counts,
    requestMs,
    activeElapsedMs,
    assetSemantics,
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
