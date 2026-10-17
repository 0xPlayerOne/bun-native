import { createInterface } from 'node:readline';
let ticks=0;const timer=setInterval(()=>ticks++,1);
const input=createInterface({input:process.stdin});
setTimeout(()=>process.stdout.write('ready\n'),20);
input.on('line',(line:string)=>{
 if(line!=='ping'){process.exitCode=2;input.close();clearInterval(timer);return;}
 process.stdout.write(`pong:${ticks}\n`);clearInterval(timer);input.close();process.stdin.pause();
});
input.on('close',()=>clearInterval(timer));
