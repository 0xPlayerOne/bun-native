/**
 * AOT number-to-string retention control (M9). No Bun Native, framework,
 * native host or file I/O: each round converts one number to a string and
 * drops it. Samples take a forced collection and count live strings whose
 * text is an integer or a decimal, from a V8-format heap snapshot.
 *
 *   bun benchmarks/retention/aot-number-strings.js int|float|string [ROUNDS]
 *   bun --no-install compile --no-script --production \
 *     benchmarks/retention/aot-number-strings.js --outfile <new-file>
 *   <new-file> int|float|string [ROUNDS]
 *
 * int: `Round ${round} task`; float: `${milliseconds}\n`, the soaks'
 * rounds.txt line; string: String(milliseconds).
 */
import { heapStats } from 'bun:jsc'

const variant = process.argv[2]
const rounds = Number(process.argv[3] ?? 10_000)
if (!['int', 'float', 'string'].includes(variant) || !Number.isInteger(rounds) || rounds < 2_500)
  throw new Error('usage: aot-number-strings.js int|float|string [ROUNDS >= 2500]')

function numericStrings() {
  const snapshot = JSON.parse(Bun.generateHeapSnapshot('v8'))
  const fields = snapshot.snapshot.meta.node_fields
  const type = fields.indexOf('type')
  const name = fields.indexOf('name')
  const string = snapshot.snapshot.meta.node_types[0].indexOf('string')
  let integers = 0
  let decimals = 0
  for (let node = 0; node < snapshot.nodes.length; node += fields.length) {
    if (snapshot.nodes[node + type] !== string) continue
    const text = snapshot.strings[snapshot.nodes[node + name]]
    if (/^\d+$/.test(text)) integers++
    else if (/^\d+\.\d+$/.test(text)) decimals++
  }
  return { integers, decimals }
}

async function sample(round) {
  await Bun.sleep(0)
  Bun.gc(true)
  await Bun.sleep(0)
  const statistics = heapStats()
  const row = {
    round,
    objects: statistics.objectCount,
    strings: statistics.objectTypeCounts.string,
  }
  console.log(JSON.stringify({ ...row, ...numericStrings() }))
}

let length = 0
await sample(0)
for (let round = 0; round < rounds; round++) {
  const milliseconds = performance.now() + round / 7
  if (variant === 'int') length += `Round ${round} task`.length
  else if (variant === 'float') length += `${milliseconds}\n`.length
  else length += String(milliseconds).length
  if (round % 50 === 0) await Bun.sleep(0)
  if ((round + 1) % 2_500 === 0) await sample(round + 1)
}
if (length <= 0) throw new Error('No string was produced')
