import { mkdir,copyFile,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
const root=resolve(import.meta.dir,'..');
for(const name of ['contracts','client','runtime','artifacts','cli']) {
 const outdir=join(root,`packages/${name}/dist`);await rm(outdir,{recursive:true,force:true});
 const result=await Bun.build({entrypoints:[join(root,`packages/${name}/src/${name==='cli'?'main':'index'}.ts`)],outdir,
  target:name==='client'||name==='contracts'?'browser':'bun',sourcemap:'external'});
 if(!result.success)throw new AggregateError(result.logs,`Failed to bundle ${name}`);
}
const outdir=join(root,'examples/workbench/dist');await mkdir(outdir,{recursive:true});
for(const [entry,target] of [['main','bun'],['browser','browser']] as const) {
 const result=await Bun.build({entrypoints:[join(root,`examples/workbench/${entry}.ts`)],outdir,target,sourcemap:'external'});
 if(!result.success)throw new AggregateError(result.logs,'Failed to build example');
}
await copyFile(join(root,'examples/workbench/index.html'),join(outdir,'index.html'));
console.log('Built SDK, CLI, and contract workbench. No native toolchain invoked.');
