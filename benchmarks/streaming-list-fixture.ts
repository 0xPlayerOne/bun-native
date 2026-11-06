/**
 * Versioned deterministic streaming/virtualization workload (#257).
 *
 * The content depends only on these constants and the message or tick index,
 * never on time, so every framework and build mode replays the same history
 * and token stream. Comparative measurements (#244) must cite the version.
 */
export const STREAMING_LIST_FIXTURE = Object.freeze({
  version: 1,
  /** Committed history before streaming starts; far above the 4,096-node window limit. */
  historyMessages: 10_000,
  /** Streamed tokens. Each tick appends exactly one token to the open message. */
  ticks: 2_400,
  /** Requested producer period. Actual cadence is measured, not assumed. */
  tickIntervalMs: 4,
  /** A streamed message completes after this many tokens and the next one opens. */
  tokensPerMessage: 16,
  /** History messages carry this many words. */
  historyWords: 10,
  seed: 0x2570_0001,
})

const WORDS = [
  'native',
  'stream',
  'window',
  'layout',
  'token',
  'render',
  'commit',
  'shared',
  'message',
  'history',
  'select',
  'anchor',
  'theme',
  'density',
  'frame',
  'bounded',
  'handle',
  'listener',
  'compact',
  'adapter',
  'GPUI',
  'Solid',
  'React',
  'host',
] as const

/** Stateless 32-bit integer mix; a pure function of its input. */
function mix(value: number): number {
  let x = (value ^ STREAMING_LIST_FIXTURE.seed) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

export function fixtureWord(index: number): string {
  return WORDS[mix(index) % WORDS.length]!
}

export function historyText(message: number): string {
  const words: string[] = []
  for (let word = 0; word < STREAMING_LIST_FIXTURE.historyWords; word++)
    words.push(fixtureWord(message * 64 + word))
  return words.join(' ')
}

/** The token appended at a stream tick, including its separating space. */
export function streamToken(tick: number): string {
  const position = tick % STREAMING_LIST_FIXTURE.tokensPerMessage
  return (position === 0 ? '' : ' ') + fixtureWord(1_000_000 + tick)
}

/** FNV-1a over UTF-16 code units, for cross-framework final-state comparison. */
export function digest(values: Iterable<string>): string {
  let hash = 0x811c9dc5
  for (const value of values) {
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0x0a
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
