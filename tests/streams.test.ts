import { afterEach, describe, expect, test } from 'bun:test';
import { BinaryStreamSender, BinaryStreamReceiver } from '../packages/contracts/src/streams.ts';
import type { BinaryStreamOptions, BinaryStreamSink } from '../packages/contracts/src/streams.ts';
import { StreamBudget } from '../packages/contracts/src/stream-budget.ts';
import { StreamError, StreamFramer, decodeStream, encodeStream, streamFrame, writeStreamPacket } from '../packages/contracts/src/stream-wire.ts';
import type { StreamFrame } from '../packages/contracts/src/stream-wire.ts';
import type { RpcTransport } from '../packages/contracts/src/rpc.ts';
import { rpcMessagePort } from '../packages/client/src/rpc-port.ts';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function deferred<T = void>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((r,j) => { resolve=r; reject=j; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
const result = <T>(p: Promise<T>) => p.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as StreamError }));
class Wire implements RpcTransport {
  peer!: Wire; message: ((p: Uint8Array) => void) | undefined; ended: (() => void) | undefined;
  dead = false; packets: Uint8Array[] = []; sent = 0; hold: Promise<void> | undefined; block = false;
  send(packet: Uint8Array): void | Promise<void> {
    if (this.dead) throw new Error('dead'); this.sent++; if (this.packets.length < 200) this.packets.push(packet.slice());
    if (this.block) return new Promise(() => {});
    this.peer.message?.(packet.slice()); return this.hold;
  }
  subscribe(message: (p: Uint8Array) => void, ended: () => void): () => void {
    this.message=message; this.ended=ended; if (this.dead) ended(); return () => { this.message=undefined; this.ended=undefined; };
  }
  close(): void { if (this.dead) return; this.dead=true; this.ended?.(); this.peer.close(); }
}
function pair() { const left = new Wire(), right = new Wire(); left.peer=right; right.peer=left; return { left, right }; }
function setup(sink: BinaryStreamSink = { consume: () => {} }, opts: { sender?: Partial<BinaryStreamOptions>; receiver?: Partial<BinaryStreamOptions> } = {}) {
  const wire=pair(), sb=new StreamBudget(), rb=new StreamBudget();
  const receiver = new BinaryStreamReceiver(wire.right, { budget: rb, owner: {}, maxChunkBytes: 128, ...opts.receiver }, { terminal: sink });
  const sender = new BinaryStreamSender(wire.left, { budget: sb, owner: {}, maxChunkBytes: 128, ...opts.sender });
  cleanups.push(() => { sender.close(); receiver.close(); }); return { sender, receiver, sb, rb, ...wire };
}
const data = (id=1, sequence=1, bytes: Uint8Array=new Uint8Array([1,2,3])) => streamFrame('data',id,sequence,0,bytes);

describe('stream wire and bounded incremental parser', () => {
  test('roundtrips every frame kind, empty close and consumed-byte acknowledgment', () => {
    const frames = [streamFrame('open',1,0,0,new TextEncoder().encode('terminal')),streamFrame('opened',1),data(),
      streamFrame('ack',1,1,3),streamFrame('close',1,1),streamFrame('closed',1,1),streamFrame('cancel',1),streamFrame('error',1,0,1)];
    for(const f of frames) expect(decodeStream(encodeStream(f))).toEqual(f);
  });
  test('slice encoding excludes unrelated backing bytes', () => {
    const b=new Uint8Array([99,1,2,98]); const encoded=encodeStream(data(1,1,b.subarray(1,3))); b.fill(0);
    expect(decodeStream(encoded).body).toEqual(new Uint8Array([1,2]));
  });
  test('header magic/version/reserved bits/kind/identity/size are strict', () => {
    const p=encodeStream(data());
    for(const index of [0,4,5,6,16]) { const b=p.slice();b[index]=255;expect(()=>decodeStream(b)).toThrow(StreamError); }
    for(const n of [0,1,23,p.length-1]) expect(()=>decodeStream(p.slice(0,n))).toThrow();
    const bad=p.slice();new DataView(bad.buffer).setUint32(8,0);expect(()=>decodeStream(bad)).toThrow();
    expect(()=>decodeStream(new Uint8Array([...p,0]))).toThrow();
  });
  test('rejects empty chunks, oversized open names, JSON authority and shared buffers', () => {
    expect(()=>encodeStream(data(1,1,new Uint8Array()))).toThrow();
    expect(()=>encodeStream(data(1,0))).toThrow();
    expect(()=>encodeStream(streamFrame('open',1,0,0,new TextEncoder().encode('{"viewId":1}')))).toThrow();
    expect(()=>encodeStream(streamFrame('open',1,0,0,new Uint8Array(129)))).toThrow();
    expect(()=>encodeStream(data(1,1,new Uint8Array(new SharedArrayBuffer(5))))).toThrow();
    expect(()=>encodeStream(streamFrame('cancel',1,1))).toThrow();
    expect(()=>encodeStream(streamFrame('error',1,0,99))).toThrow();
  });
  test('fragmented headers and payloads reassemble once and in order', () => {
    const frames=[data(1,1,new Uint8Array(128).fill(7)),streamFrame('close',1,1)];
    const joined=new Uint8Array(frames.reduce((n,f)=>n+encodeStream(f,128).length,0));let offset=0;
    for(const f of frames){const p=encodeStream(f,128);joined.set(p,offset);offset+=p.length;}
    for(const size of [1,2,7,23,24,31,177]) {
      const actual:StreamFrame[]=[]; const f=new StreamFramer(p=>actual.push(decodeStream(p,128)),128);
      for(let i=0;i<joined.length;i+=size) {f.push(joined.subarray(i,i+size));expect(f.diagnostics()).toBeLessThanOrEqual(152);} f.finish();expect(actual).toEqual(frames);
    }
  });
  test('partial EOF, impossible announced length and reentrant parser fail closed', () => {
    const f=new StreamFramer(()=>{},128);f.push(encodeStream(data()).subarray(0,10));expect(()=>f.finish()).toThrow();expect(f.diagnostics()).toBe(0);
    const bad=encodeStream(data()).slice(0,24);new DataView(bad.buffer).setUint32(16,0xffffffff);
    const b=new StreamFramer(()=>{},128);expect(()=>b.push(bad)).toThrow();expect(b.diagnostics()).toBe(0);
    const r=new StreamFramer(()=>r.push(encodeStream(data())),128);expect(()=>r.push(encodeStream(data()))).toThrow();
  });
});
describe('lossless consumption and lifecycle',()=>{
  test('write waits for consumer completion, not transport handoff', async()=>{
    const gate=deferred();let consumed=0;const env=setup({consume:async b=>{await gate.promise;consumed+=b.length;}});
    const writer=await env.sender.open('terminal');let done=false;const p=writer.write(new Uint8Array([1,2])).then(()=>{done=true;});await flush();
    expect(done).toBe(false);expect(consumed).toBe(0);await expect(writer.write(new Uint8Array([3]))).rejects.toMatchObject({code:'OVERLOADED'});
    gate.resolve();await p;expect(consumed).toBe(2);await writer.end();expect(await writer.finished).toEqual({ok:true});
    await flush();expect(env.sb.diagnostics().reservedBytes).toBe(0);expect(env.rb.diagnostics().reservedBytes).toBe(0);
  });
  test('sustained stream retains exact order/checksum without producer backlog',async()=>{
    let expected=0,sum=0;const env=setup({consume:b=>{expect(new DataView(b.buffer).getUint32(0)).toBe(expected++);for(const x of b)sum+=x;}});
    const writer=await env.sender.open('terminal');let input=0;
    for(let i=0;i<1000;i++){const b=new Uint8Array(128).fill(i%251);new DataView(b.buffer).setUint32(0,i);for(const x of b)input+=x;await writer.write(b);
      expect(env.sender.diagnostics().queuedFrames).toBeLessThanOrEqual(1);expect(env.sb.diagnostics().reservedBytes).toBe(456);}
    await writer.end();expect(expected).toBe(1000);expect(sum).toBe(input);
  });
  test('finish callback is acknowledged before graceful end',async()=>{
    const gate=deferred();const env=setup({consume:()=>{},finish:()=>gate.promise});const writer=await env.sender.open('terminal');let done=false;
    const p=writer.end().then(()=>{done=true;});await flush();expect(done).toBe(false);gate.resolve();await p;expect(await writer.finished).toEqual({ok:true});
  });
  test('cancellation reaches sink and preserves its reservation until it settles',async()=>{
    const gate=deferred();let signal:AbortSignal|undefined;const env=setup({consume:(_,c)=>{signal=c.signal;return gate.promise;}});
    const w=await env.sender.open('terminal');const p=result(w.write(new Uint8Array([1])));await flush();w.cancel();
    expect((await p).error?.code).toBe('CANCELLED');expect(signal?.aborted).toBe(true);expect(env.rb.diagnostics().streams).toBe(1);
    gate.resolve();await flush();expect(env.rb.diagnostics().streams).toBe(0);expect(await w.finished).toEqual({ok:false,code:'CANCELLED'});
  });
  test('cancellation before open does not allocate a stream',async()=>{
    const env=setup();const abort=new AbortController();abort.abort();await expect(env.sender.open('terminal',{signal:abort.signal})).rejects.toMatchObject({code:'CANCELLED'});
    expect(env.sb.diagnostics().streams).toBe(0);expect(env.left.sent).toBe(0);
  });
  test('whole-connection revocation settles pending operations',async()=>{
    const abort=new AbortController(),gate=deferred();const env=setup({consume:()=>gate.promise},{sender:{signal:abort.signal}});
    const w=await env.sender.open('terminal');const p=result(w.write(new Uint8Array([1])));await flush();abort.abort();
    expect((await p).error?.code).toBe('CANCELLED');expect(env.sender.diagnostics().streams).toBe(0);gate.resolve();await flush();expect(env.rb.diagnostics().streams).toBe(0);
  });
  test('consumer exceptions expose only a fixed error code',async()=>{
    const env=setup({consume:()=>{throw new Error('/secret/path token');}});const w=await env.sender.open('terminal');const r=await result(w.write(new Uint8Array([1])));
    expect(r.error?.code).toBe('CONSUMER_FAILED');expect(r.error?.message).not.toContain('secret');expect(await w.finished).toEqual({ok:false,code:'CONSUMER_FAILED'});
  });
  test('a stalled consumer times out without recycling its still-live reservation',async()=>{
    const gate=deferred();const env=setup({consume:()=>gate.promise},{sender:{timeoutMs:15},receiver:{timeoutMs:15}});
    const w=await env.sender.open('terminal');await expect(w.write(new Uint8Array([1]))).rejects.toMatchObject({code:'DEADLINE_EXCEEDED'});
    expect(env.rb.diagnostics().streams).toBe(1);gate.resolve();await flush();expect(env.rb.diagnostics().streams).toBe(0);
  });
  test('duplicate or out-of-order data closes the lane before another consumer starts',async()=>{
    const gate=deferred();let calls=0;const env=setup({consume:()=>{calls++;return gate.promise;}});const w=await env.sender.open('terminal');
    const p=result(w.write(new Uint8Array([1])));await flush();env.right.message?.(encodeStream(data(1,2)));
    expect((await env.receiver.closed).code).toBe('PROTOCOL_ERROR');expect(calls).toBe(1);await p;gate.resolve();
  });
  test('wrong byte acknowledgements fail instead of releasing credit',async()=>{
    const gate=deferred();const env=setup({consume:()=>gate.promise});const w=await env.sender.open('terminal');const p=result(w.write(new Uint8Array([1,2])));
    await flush();env.left.message?.(encodeStream(streamFrame('ack',1,1,1)));expect((await p).error?.code).toBe('PROTOCOL_ERROR');gate.resolve();
  });
  test('denies unauthorized sinks and invalid modes without installing handlers',async()=>{
    const env=setup();await expect(env.sender.open('admin')).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(env.sender.open('terminal',{mode:'lossy' as 'lossless'})).rejects.toMatchObject({code:'PROTOCOL_ERROR'});
    expect(env.rb.diagnostics().streams).toBe(0);const w=await env.sender.open('terminal');await w.end();
  });
  test('oversized/empty writes are rejected without silently dropping the active stream',async()=>{
    const env=setup();const w=await env.sender.open('terminal');for(const b of [new Uint8Array(),new Uint8Array(129)])await expect(w.write(b)).rejects.toMatchObject({code:'PROTOCOL_ERROR'});
    await w.write(new Uint8Array([1]));await w.end();
  });
  test('many streams share bounded per-view admission and close releases idle slots',async()=>{
    const sb=new StreamBudget({maxStreamsPerView:2});const env=setup(undefined,{sender:{budget:sb}});const a=await env.sender.open('terminal'),b=await env.sender.open('terminal');
    await expect(env.sender.open('terminal')).rejects.toMatchObject({code:'OVERLOADED'});expect(sb.diagnostics().streams).toBe(2);await a.end();await b.end();expect(sb.diagnostics().streams).toBe(0);
  });
  test('a raw adapter which never drains cannot free its reservation on close',async()=>{
    const gate=deferred();const env=setup(undefined,{sender:{sendTimeoutMs:15}});env.left.hold=gate.promise;
    await expect(env.sender.open('terminal')).rejects.toMatchObject({code:'DEADLINE_EXCEEDED'});expect(env.sb.diagnostics().streams).toBe(1);
    gate.resolve();await flush();expect(env.sb.diagnostics().streams).toBe(0);
  });
  test('MessagePort end-to-end consumption and explicit close',async()=>{
    const p=new MessageChannel();let received=0;const receiver=new BinaryStreamReceiver(rpcMessagePort(p.port1),{budget:new StreamBudget(),owner:{}},{terminal:{consume:b=>{received+=b.length;}}});
    const sender=new BinaryStreamSender(rpcMessagePort(p.port2),{budget:new StreamBudget(),owner:{}});cleanups.push(()=>{sender.close();receiver.close();});
    const w=await sender.open('terminal');await w.write(new Uint8Array(1024));await w.end();expect(received).toBe(1024);
  });
});
describe('host-shared budget',()=>{
  test('per-stream, per-view and global bytes are separate limits',()=>{
    const b=new StreamBudget({maxBytes:900,maxBytesPerView:600,maxBytesPerStream:400}),a={},c={};
    expect(()=>b.reserve(a,401)).toThrow();const r1=b.reserve(a,350);expect(()=>b.reserve(a,300)).toThrow();const r2=b.reserve(c,350);
    expect(()=>b.reserve({},300)).toThrow();r1();r1();r2();expect(b.diagnostics()).toEqual({reservedBytes:0,streams:0,views:0});
  });
  test('reconnecting cannot bypass a blocked consumer reservation',async()=>{
    const pool=new StreamBudget({maxStreamsPerView:1}),owner={},gate=deferred();const first=setup({consume:()=>gate.promise},{receiver:{budget:pool,owner}});
    const w=await first.sender.open('terminal');const p=result(w.write(new Uint8Array([1])));await flush();w.cancel();await p;
    const next=setup(undefined,{receiver:{budget:pool,owner}});await expect(next.sender.open('terminal')).rejects.toMatchObject({code:'OVERLOADED'});
    gate.resolve();await flush();const accepted=await next.sender.open('terminal');await accepted.end();expect(pool.diagnostics().streams).toBe(0);
  });
});

describe('adversarial flow control and adapter boundaries',()=>{
  test('a queued ACK cannot grant credit before it is actually sent',async()=>{
    const gate=deferred();let calls=0;const env=setup({consume:()=>{calls++;}});const w=await env.sender.open('terminal');await flush();
    env.right.hold=gate.promise;
    await w.write(new Uint8Array([1])); // ACK one delivered, but its transport handoff is still retained.
    const second=result(w.write(new Uint8Array([2])));await flush();expect(calls).toBe(2);
    env.right.message?.(encodeStream(data(1,3))); // ACK two is still queued: no third credit.
    expect((await env.receiver.closed).code).toBe('PROTOCOL_ERROR');expect(calls).toBe(2);
    await second;expect(env.rb.diagnostics().streams).toBe(1);gate.resolve();await flush();expect(env.rb.diagnostics().streams).toBe(0);
  });
  test('duplicate open and future response identities fail closed',async()=>{
    const env=setup();await env.sender.open('terminal');env.right.message?.(encodeStream(streamFrame('open',1,0,0,new TextEncoder().encode('terminal'))));
    expect((await env.receiver.closed).code).toBe('PROTOCOL_ERROR');
    const next=setup();next.left.message?.(encodeStream(streamFrame('opened',999)));expect((await next.sender.closed).code).toBe('PROTOCOL_ERROR');
  });
  test('a copied input is unaffected by caller mutation after write',async()=>{
    const gate=deferred();let saved:Uint8Array|undefined;const env=setup({consume:async b=>{await gate.promise;saved=b.slice();}});
    const w=await env.sender.open('terminal');const b=new Uint8Array([7,8,9]);const p=w.write(b);b.fill(0);gate.resolve();await p;expect(saved).toEqual(new Uint8Array([7,8,9]));await w.end();
  });
  test('graceful close while DATA is outstanding rejects rather than skipping consumption',async()=>{
    const gate=deferred();const env=setup({consume:()=>gate.promise});const w=await env.sender.open('terminal');const p=w.write(new Uint8Array([1]));
    await expect(w.end()).rejects.toMatchObject({code:'OVERLOADED'});gate.resolve();await p;await w.end();expect(await w.finished).toEqual({ok:true});
    await expect(w.write(new Uint8Array([1]))).rejects.toMatchObject({code:'DISCONNECTED'});w.cancel();
  });
  test('consumer finalization failure rejects end and releases the reservation',async()=>{
    const env=setup({consume:()=>{},finish:()=>{throw new Error('private');}});const w=await env.sender.open('terminal');
    await expect(w.end()).rejects.toMatchObject({code:'CONSUMER_FAILED'});await flush();expect(env.rb.diagnostics().streams).toBe(0);
  });
  test('consumer deadline is checked even when its timer callback has not run',async()=>{
    let time=0;const callbacks=new Map<object,()=>void>();const scheduler={now:()=>time,set:(_ms:number,fn:()=>void)=>{const t={};callbacks.set(t,fn);return t;},clear:(t:unknown)=>{callbacks.delete(t as object);}};
    const gate=deferred();const env=setup({consume:()=>gate.promise},{receiver:{scheduler,timeoutMs:10}});const w=await env.sender.open('terminal');
    const p=result(w.write(new Uint8Array([1])));await flush();time=20;gate.resolve();expect((await p).error?.code).toBe('DEADLINE_EXCEEDED');expect(callbacks.size).toBe(0);
  });
  test('partial writer handles short writes and rejects zero, invalid or overlong results',async()=>{
    const p=encodeStream(data());let collected:number[]=[];
    await writeStreamPacket(p,chunk=>{const n=Math.min(3,chunk.length);collected.push(...chunk.subarray(0,n));return n;});expect(collected).toEqual(Array.from(p));
    for(const n of [0,-1,1.5,Infinity,p.length+1])await expect(writeStreamPacket(p,()=>n)).rejects.toMatchObject({code:'DISCONNECTED'});
    collected=[];await expect(writeStreamPacket(p,()=>{throw new Error('native write failed');})).rejects.toThrow('native write failed');
  });
  test('seeded malformed packets never enter a sink or allocate unbounded parser buffers',()=>{
    let seed=0x1a2b3c4d;
    for(let n=0;n<1000;n++){
      const b=new Uint8Array(n%257);for(let i=0;i<b.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;b[i]=seed>>>24;}
      if(b.length>=4)b[0]=0;expect(()=>decodeStream(b,128)).toThrow(StreamError);
    }
  });
  test('invalid limits and configuration fail before transport subscription',()=>{
    const p=pair(),budget=new StreamBudget();
    for(const opts of [{maxChunkBytes:0},{timeoutMs:0},{sendTimeoutMs:Infinity},{maxQueuedFrames:5000},{maxQueuedBytes:1}])
      expect(()=>new BinaryStreamSender(p.left,{budget,owner:{},...opts})).toThrow();
    expect(p.left.message).toBeUndefined();expect(()=>new StreamBudget({maxBytesPerStream:0})).toThrow();
  });
  test('aborting one stream does not disconnect independent streams',async()=>{
    const gate=deferred();const env=setup({consume:b=>b[0]===1?gate.promise:undefined});const a=await env.sender.open('terminal'),b=await env.sender.open('terminal');
    const p=result(a.write(new Uint8Array([1])));await flush();a.cancel();await p;await b.write(new Uint8Array([2]));await b.end();expect(env.sender.diagnostics().closed).toBe(false);gate.resolve();
  });
});
