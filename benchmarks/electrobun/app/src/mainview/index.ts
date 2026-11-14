// DOM port of benchmarks/solid/workload.ts: same tree shape (label, button, 32 keyed
// rows), same phase counts and the same lifecycle. Timings are DOM mutation time
// ("submission") and time to the next animation frame ("frame"). Neither is the
// Bun Native host acknowledgement, so the two are not interchangeable.
const params = new URLSearchParams(location.search)
const port = params.get('port')
const iterations = Number(params.get('iterations') ?? 1000)
const rotations = Number(params.get('rotations') ?? 1000)
const mounts = Number(params.get('mounts') ?? 100)
const rowCount = Number(params.get('rows') ?? 32)

type Row = { id: number; text: string }
const initial: Row[] = Array.from({ length: rowCount }, (_, id) => ({ id, text: `Row ${id}` }))
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null
  return {
    count: samples.length,
    p50Ms: rank(0.5),
    p95Ms: rank(0.95),
    p99Ms: rank(0.99),
    totalMs: samples.reduce((sum, value) => sum + value, 0),
    samplesMs: samples,
  }
}

class View {
  label = document.createElement('div')
  button = document.createElement('button')
  list = document.createElement('div')
  rows = new Map<number, HTMLElement>()
  root = document.createElement('div')
  mutations = { create: 0, set: 0, insert: 0, remove: 0 }
  constructor(rows: readonly Row[]) {
    this.root.className = 'content'
    this.label.textContent = 'Initial'
    this.button.textContent = 'Benchmark fixture'
    this.list.className = 'list'
    for (const row of rows) {
      const node = document.createElement('div')
      node.className = 'row'
      node.textContent = row.text
      this.rows.set(row.id, node)
      this.list.append(node)
    }
    this.root.append(this.label, this.button, this.list)
    document.getElementById('window-root')!.append(this.root)
    this.mutations.create += 3 + rows.length
  }
  update(values: readonly string[]) {
    for (const value of values) {
      this.label.textContent = value
      this.mutations.set++
    }
  }
  rotate(rows: readonly Row[]) {
    for (const row of rows) this.list.append(this.rows.get(row.id)!)
    this.mutations.insert++
  }
  dispose() {
    this.root.remove()
    this.rows.clear()
  }
}

async function main() {
  const startup = {
    timeOriginEpochMs: performance.timeOrigin,
    scriptStartMs: performance.now(),
  }
  if (params.get('input') === '1') document.body.classList.add('input-comparison')
  let view = new View(initial)
  if (params.get('input') === '1') {
    const nonce = params.get('nonce')
    if (!nonce) throw new Error('Visible-input comparison requires a nonce')
    const post = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/input/${path}`, {
        method: 'POST',
        headers: { 'x-benchmark-nonce': nonce },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error(`Input ${path} failed: ${response.status}`)
    }
    let clicks = 0
    let mountedMs = 0
    view.button.addEventListener('click', () => {
      clicks++
      view.update(['Clicked'])
    })
    // The controller requests the report only after its capture, so a loopback
    // fetch cannot run concurrently with the measured click-to-observation path.
    window.addEventListener('bun-native-benchmark-finish', () => {
      void post('clicked', {
        nonce,
        clicks,
        label: view.label.textContent,
        startup: { ...startup, viewMountedMs: mountedMs },
        workload: { iterations, rotations, mounts, rows: rowCount, warmup: 0 },
        userAgent: navigator.userAgent,
      }).catch((error) =>
        fetch(`http://127.0.0.1:${port}/report`, {
          method: 'POST',
          headers: { 'x-benchmark-nonce': nonce },
          body: JSON.stringify({ error: String(error?.stack ?? error) }),
        })
      )
    })
    await frame()
    mountedMs = performance.now()
    await post('ready', [window.innerWidth, window.innerHeight])
    return
  }
  await frame()
  const mountedMs = performance.now()
  for (let index = 0; index < 20; index++) {
    view.update([`Warmup ${index}`])
    await frame()
  }
  const phases: Record<string, unknown> = {}
  async function measure(name: string, count: number, operation: (index: number) => void) {
    const submission: number[] = []
    const toFrame: number[] = []
    const before = { ...view.mutations }
    for (let index = 0; index < count; index++) {
      const start = performance.now()
      operation(index)
      submission.push(performance.now() - start)
      await frame()
      toFrame.push(performance.now() - start)
    }
    phases[name] = {
      synchronousSubmission: distribution(submission),
      toNextFrame: distribution(toFrame),
      mutations: {
        set: view.mutations.set - before.set,
        insert: view.mutations.insert - before.insert,
        create: view.mutations.create - before.create,
        remove: view.mutations.remove - before.remove,
      },
    }
  }
  await measure('signals', iterations, (index) => view.update([`Update ${index}`]))
  const coalesced = Array.from({ length: 10 }, (_, index) => `Batched ${index}`)
  await measure('coalesced', iterations / 10, (index) =>
    view.update(coalesced.map((value) => `${index}: ${value}`))
  )
  let ordered = initial
  await measure('keyedRotations', rotations, () => {
    ordered = [...ordered.slice(1), ordered[0]!]
    view.rotate(ordered)
  })
  view.dispose()
  const lifecycle: number[] = []
  for (let index = 0; index < mounts; index++) {
    const start = performance.now()
    view = new View(initial)
    view.update([`Lifecycle ${index}`])
    await frame()
    view.dispose()
    lifecycle.push(performance.now() - start)
  }
  const memory = (performance as unknown as { memory?: unknown }).memory ?? null
  await fetch(`http://127.0.0.1:${port}/report`, {
    method: 'POST',
    body: JSON.stringify({
      startup: { ...startup, viewMountedMs: mountedMs },
      workload: { iterations, rotations, mounts, rows: rowCount, warmup: 20 },
      phases,
      lifecycles: distribution(lifecycle),
      memory,
      userAgent: navigator.userAgent,
    }),
  })
}
main().catch(async (error) => {
  const nonce = params.get('input') === '1' ? params.get('nonce') : null
  await fetch(`http://127.0.0.1:${port}/report`, {
    method: 'POST',
    ...(nonce ? { headers: { 'x-benchmark-nonce': nonce } } : {}),
    body: JSON.stringify({ error: String(error?.stack ?? error) }),
  })
})
