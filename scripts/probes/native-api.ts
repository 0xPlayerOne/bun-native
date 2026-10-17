import { dlopen, FFIType, JSCallback } from 'bun:ffi';
import { createRequire } from 'node:module';
export interface NativeApi { abi():number;add(a:number,b:number):number;checksum(bytes:Uint8Array):number;
 markMain():number;post(value:number):number;run(timeout:number):number;stop():number;
 setCallback(fn:(value:number)=>void):number;clearCallback():number;close():void }
export function loadNative(path:string,mode:'ffi'|'napi'):NativeApi {
 if(mode==='napi') {const module=createRequire(import.meta.url)(path) as Omit<NativeApi,'close'>;return {...module,close(){}};}
 const lib=dlopen(path,{
  bunly_probe_abi:{args:[],returns:FFIType.u32},bunly_probe_add:{args:[FFIType.u32,FFIType.u32],returns:FFIType.u32},
  bunly_probe_checksum:{args:[FFIType.ptr,FFIType.u64],returns:FFIType.u32},bunly_probe_mark_main:{args:[],returns:FFIType.i32},
  bunly_probe_post:{args:[FFIType.u32],returns:FFIType.i32},bunly_probe_run:{args:[FFIType.u32],returns:FFIType.i32},
  bunly_probe_stop:{args:[],returns:FFIType.i32},bunly_probe_callback:{args:[FFIType.ptr],returns:FFIType.i32},
 });
 let callback:JSCallback|undefined;
 return {abi:()=>lib.symbols.bunly_probe_abi(),add:(a,b)=>lib.symbols.bunly_probe_add(a,b),
  checksum:bytes=>lib.symbols.bunly_probe_checksum(bytes,bytes.length),markMain:()=>lib.symbols.bunly_probe_mark_main(),
  post:value=>lib.symbols.bunly_probe_post(value),run:timeout=>lib.symbols.bunly_probe_run(timeout),stop:()=>lib.symbols.bunly_probe_stop(),
  setCallback(fn){callback=new JSCallback(fn,{args:[FFIType.u32],returns:FFIType.void,threadsafe:true});return lib.symbols.bunly_probe_callback(callback.ptr);},
  clearCallback(){const status=lib.symbols.bunly_probe_callback(null);if(status===0){callback?.close();callback=undefined;}return status;},
  close(){if(callback) throw new Error('Clear callback before closing');lib.close();},
 };
}
