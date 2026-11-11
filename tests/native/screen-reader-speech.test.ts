import { expect, test } from 'bun:test'
import { nvdaSpeech } from './screen-reader-speech.ts'

test('NVDA IO-level speech records become phrases in order', () => {
  const log = [
    'INFO - core.main (10:00:00.000) - MainThread (1):',
    'NVDA initialized',
    'IO - speech.speech.speak (10:00:01.000) - MainThread (1):',
    "Speaking ['Leading action', 'button', CancellableSpeech (still valid)]",
    'IO - speech.speech.speak (10:00:02.000) - MainThread (1):',
    "Speaking [\"Don't save\", 'button']",
    'IO - speech.speech.speak (10:00:03.000) - MainThread (1):',
    'Speaking [CancellableSpeech (still valid)]',
    'IO - speech.speech.speak (10:00:04.000) - MainThread (1):',
    "Speaking ['edit', '  read only  ', 'Fixed', 'it\\'s']",
  ].join('\r\n')
  expect(nvdaSpeech(log)).toEqual([
    'Leading action button',
    "Don't save button",
    "edit read only Fixed it's",
  ])
})
