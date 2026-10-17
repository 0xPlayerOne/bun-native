import { setTimeout as sleep } from 'node:timers/promises';
const cursor = Number(process.argv[2] ?? 0);
if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 128) throw new Error('Invalid command cursor');
console.log(JSON.stringify({ event: 'ready', cursor }));
for (let sequence = cursor; sequence < 128; sequence++) {
  console.log(JSON.stringify({ event: 'item', sequence, text: `command-${sequence}` }));
  await sleep(10);
}
console.log(JSON.stringify({ event: 'completed', nextCursor: 128 }));
