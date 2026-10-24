/** Synthetic native-maintenance peer for bounded launcher tests, not native acceptance. */
const argument = process.argv.find((value) => value.startsWith('--bunly-reset-profile='))
const partition = argument?.slice('--bunly-reset-profile='.length) ?? ''
const receipt = {
  event: 'bunly.session.storage-reset',
  result: {
    schema: 1,
    partition,
    offline: true,
    storageCleared: true,
    cookiesCleared: true,
    cacheCleared: true,
    recoveredInterruption: false,
    remainingEntriesRemoved: 3,
    remainingLogicalBytesRemoved: 40,
  },
}
if (partition === 'hang') await new Promise(() => {})
else if (partition === 'overflow') {
  console.log('x'.repeat(70000))
  await new Promise(() => {})
} else if (partition === 'duplicate') {
  console.log(JSON.stringify(receipt))
  console.log(JSON.stringify(receipt))
} else if (partition === 'malformed') console.log(JSON.stringify({ ...receipt, extra: true }))
else if (partition === 'wrong-partition')
  console.log(JSON.stringify({ ...receipt, result: { ...receipt.result, partition: 'other' } }))
else if (partition === 'error') process.exitCode = 78
else console.log(JSON.stringify(receipt))

export {}
