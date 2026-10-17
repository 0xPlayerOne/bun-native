import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
const [generationText, fault] = process.argv.slice(2);
const generation = Number(generationText);
assert.ok(Number.isInteger(generation) && generation >= 0);
if (fault === 'pre-register-exit') process.exit(23);
const lines = createInterface({ input: process.stdin });
const iterator = lines[Symbol.asyncIterator]();
function write(line: string): void { writeSync(1, line + '\n'); }
let timer: ReturnType<typeof setInterval> | undefined;
try {
  write('ready'); assert.equal((await iterator.next()).value, 'start');
  if (fault === 'hang') { for (;;) { /* Isolated fault: native supervisor must kill this child. */ } }
  if (fault === 'idle-timeout') await new Promise<never>(() => {});
  write(JSON.stringify({ event: 'phase', phase: 'idle', generation }));
  await Bun.sleep(200);
  write(JSON.stringify({ event: 'phase', phase: 'work', generation }));
  let gc = 0; let ticks = 0;
  timer = setInterval(() => { ticks++; }, 2);
  const count = fault === 'callback' ? 8 : 256;
  for (let index = 0; index < count; index++) {
    const value = generation * 1024 + index;
    write(`value:${value}`); assert.equal((await iterator.next()).value, `ack:${value}`);
    if ((index + 1) % 16 === 0 && index + 1 < count) {
      const bytes = Uint8Array.from({ length: 16384 }, (_, i) => i & 255);
      Bun.gc(true); gc++;
      let hash = 2166136261; for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      assert.equal(hash, 2844483013);
      await Bun.sleep(1);
    }
  }
  clearInterval(timer); timer = undefined;
  write(`result:${count}:${gc}:${ticks}`);
  assert.equal((await iterator.next()).value, 'release');
} finally { if (timer) clearInterval(timer); lines.close(); process.stdin.destroy(); }
