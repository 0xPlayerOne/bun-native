import { describe, expect, test } from 'bun:test'
import {
  digest,
  fixtureWord,
  historyText,
  STREAMING_LIST_FIXTURE,
  streamToken,
} from '../../benchmarks/streaming-list-fixture.ts'
import { StreamingList } from '../native/streaming-list-model.ts'

// Changing any constant, word or mixing step changes the replayed content, so
// it must bump `version` and these golden values together (docs/native-lists.md).
describe('streaming fixture version 1', () => {
  test('the constants match the documented, frozen workload', () => {
    expect(Object.isFrozen(STREAMING_LIST_FIXTURE)).toBe(true)
    expect(STREAMING_LIST_FIXTURE).toEqual({
      version: 1,
      historyMessages: 10_000,
      ticks: 2_400,
      tickIntervalMs: 4,
      tokensPerMessage: 16,
      historyWords: 10,
      seed: 0x2570_0001,
    })
    expect(STREAMING_LIST_FIXTURE.ticks / STREAMING_LIST_FIXTURE.tokensPerMessage).toBe(150)
  })

  test('content is pinned to golden values', () => {
    expect(historyText(0)).toBe(
      'adapter shared anchor commit shared adapter select shared history stream'
    )
    expect(historyText(9_999)).toBe(
      'React history shared history shared GPUI message history frame adapter'
    )
    expect([0, 1, 2, 15, 16].map(streamToken)).toEqual([
      'handle',
      ' bounded',
      ' theme',
      ' adapter',
      'token',
    ])
  })

  test('the full replay ends with the documented history digest', () => {
    const list = new StreamingList()
    while (list.stream());
    expect(list.total).toBe(10_150)
    expect(list.tick).toBe(STREAMING_LIST_FIXTURE.ticks)
    expect(list.digest()).toBe('23f90d78')
  })

  test('each streamed message joins exactly tokensPerMessage words with single spaces', () => {
    const { tokensPerMessage } = STREAMING_LIST_FIXTURE
    for (const message of [0, 1, 149]) {
      let text = ''
      for (let index = 0; index < tokensPerMessage; index++)
        text += streamToken(message * tokensPerMessage + index)
      expect(text).toBe(text.trim())
      expect(text.split(' ')).toHaveLength(tokensPerMessage)
    }
  })

  test('words come from the fixed vocabulary and repeat for equal indices', () => {
    const words = new Set<string>()
    for (let index = 0; index < 5_000; index++) {
      const word = fixtureWord(index)
      expect(word).toMatch(/^[A-Za-z]+$/)
      expect(fixtureWord(index)).toBe(word)
      words.add(word)
    }
    // The 24-word vocabulary is fully used; nothing outside it appears.
    expect(words.size).toBe(24)
  })
})

describe('FNV-1a digest', () => {
  test('has fixed values for empty input and separates records', () => {
    expect(digest([])).toBe('811c9dc5')
    expect(digest([''])).toBe('0f0c6cdd')
    expect(digest([''])).not.toBe(digest(['', '']))
    expect(digest(['ab', 'c'])).not.toBe(digest(['a', 'bc']))
    expect(digest(['a', 'b'])).toBe(digest(new Set(['a', 'b'])))
  })

  test('hashes UTF-16 code units, so equal strings from any source agree', () => {
    expect(digest(['é'])).toBe(digest(['é']))
    expect(digest(['é'])).not.toBe(digest(['é']))
    expect(digest(['😀'])).toBe(digest(['😀']))
  })

  test('two models differ when their history differs', () => {
    const short = new StreamingList(10)
    const long = new StreamingList(11)
    expect(short.digest()).not.toBe(long.digest())
    expect(short.digest()).toBe(new StreamingList(10).digest())
  })
})
