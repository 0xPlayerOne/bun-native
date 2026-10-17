import { parentPort,workerData } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { loadNative } from './native-api.ts';
const {path,mode}=workerData as {path:string;mode:'ffi'|'napi'};
const api=loadNative(path,mode);assert.equal(api.abi(),1);assert.equal(api.add(40,2),42);
const bytes=Uint8Array.from({length:16384},(_,i)=>i%256);
let checksum=2166136261;for(const b of bytes) checksum=Math.imul(checksum^b,16777619)>>>0;
assert.equal(api.checksum(bytes),checksum);
let received=0;let timerTicks=0;const started=performance.now();const delays:number[]=[];let sentAt=performance.now();
assert.equal(api.setCallback(value=>{
 assert.equal(value,received);received++;delays.push(performance.now()-sentAt);
 if(received===50){clearInterval(timer);parentPort!.postMessage({received,timerTicks,delays,elapsedMs:performance.now()-started});assert.equal(api.stop(),0);}
 else {sentAt=performance.now();assert.equal(api.post(received),0);}
}),0);
// Emit READY outside the blocked parent's JS loop, then queue work when the loop is running.
const timer=setInterval(()=>{timerTicks++;},1);
setTimeout(()=>{Bun.gc(true);sentAt=performance.now();assert.equal(api.post(0),0);},30);
parentPort!.on('message',(message:unknown)=>{
 if(message==='release'){assert.equal(api.clearCallback(),0);api.close();parentPort!.postMessage({released:true});parentPort!.close();}
});
