import { expect, test } from 'bun:test'
import { completeJsonLines } from './complete-jsonl.ts'

const first = JSON.stringify({ nonce: 'fixed', type: 'layout', tree_revision: 1 })
const second = JSON.stringify({ nonce: 'fixed', type: 'layout', tree_revision: 2 })

test('a mid-append read consumes complete records but not an unterminated JSON suffix', () => {
  const snapshot = first + '\n' + second.slice(0, second.length - 4)
  expect(() => JSON.parse(snapshot.split('\n')[1]!)).toThrow(SyntaxError)
  expect(completeJsonLines(snapshot).map((line) => JSON.parse(line))).toEqual([
    { nonce: 'fixed', type: 'layout', tree_revision: 1 },
  ])
  expect(completeJsonLines(first + '\n' + second + '\n').map((line) => JSON.parse(line))).toEqual([
    { nonce: 'fixed', type: 'layout', tree_revision: 1 },
    { nonce: 'fixed', type: 'layout', tree_revision: 2 },
  ])
})

test('a complete but malformed record still fails strict evidence parsing', () => {
  const lines = completeJsonLines(first + '\n' + '{broken}' + '\n')
  expect(lines).toHaveLength(2)
  expect(() => lines.map((line) => JSON.parse(line))).toThrow(SyntaxError)
})

test('no terminated record means no observed native evidence', () => {
  expect(completeJsonLines('')).toEqual([])
  expect(completeJsonLines(first)).toEqual([])
  expect(completeJsonLines('\n')).toEqual([])
})
