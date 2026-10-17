import { mkdir, lstat, readdir, readFile, open, rename, rm, mkdtemp, realpath, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ArtifactError, sha256, verifyManifest } from './manifest.ts';
import type { ArtifactIdentity, ArtifactManifest, SignedManifest } from './manifest.ts';
import { readTar } from './tar.ts';
export interface ResolveOptions {
  readonly envelope: SignedManifest; readonly trustRoots: Readonly<Record<string,string>>;
  readonly expected: ArtifactIdentity; readonly cacheRoot: string; readonly allowedOrigins: readonly string[];
  readonly offline?: boolean; readonly signal?: AbortSignal;
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
async function exists(path: string): Promise<boolean> {try {await lstat(path);return true;} catch(e){if(code(e)==='ENOENT') return false;throw e;}}
async function inventory(root: string, base=''): Promise<string[]> {
  const found: string[]=[];
  for(const entry of await readdir(join(root,base),{withFileTypes:true})) {
    const relative=base?base+'/'+entry.name:entry.name;const stat=await lstat(join(root,relative));
    if(stat.isSymbolicLink() || (!stat.isDirectory()&&!stat.isFile())) throw new ArtifactError('UNSAFE_CACHE','Unexpected cache entry');
    if(stat.isDirectory()) found.push(...await inventory(root,relative));else found.push(relative);
  }
  return found;
}
async function validateCache(root: string, manifest: ArtifactManifest): Promise<void> {
  const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()) throw new ArtifactError('UNSAFE_CACHE','Cache entry must be a real directory');
  const actual=(await inventory(root)).sort();const expected=manifest.files.map(f=>f.path).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new ArtifactError('INTEGRITY_ERROR','Cache file inventory mismatch');
  for(const file of manifest.files) {
    const path=join(root,file.path);const stat=await lstat(path);
    if(!stat.isFile()||stat.size!==file.size||sha256(await readFile(path))!==file.sha256)
      throw new ArtifactError('INTEGRITY_ERROR',`Corrupt cached file: ${file.path}`);
    if(process.platform!=='win32' && (stat.mode&0o777)!==(file.executable?0o700:0o600)) throw new ArtifactError('INTEGRITY_ERROR','Cache mode mismatch');
  }
}
async function download(manifest: ArtifactManifest, options: ResolveOptions, signal: AbortSignal): Promise<Uint8Array> {
  const fetcher=options.fetcher??((url:string,init:RequestInit)=>fetch(url,init));let url=new URL(manifest.archive.url);
  for(let redirects=0;redirects<=3;redirects++) {
    if(url.protocol!=='https:'||url.username||url.password||!options.allowedOrigins.includes(url.origin)) throw new ArtifactError('UNTRUSTED_ORIGIN','Artifact origin not allowed');
    const response=await fetcher(url.href,{redirect:'manual',credentials:'omit',signal});
    if([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location) throw new ArtifactError('DOWNLOAD_FAILED','Redirect missing location');url=new URL(location,url);continue;
    }
    if(response.status!==200||!response.body) {await response.body?.cancel();throw new ArtifactError('DOWNLOAD_FAILED',`Unexpected download status ${response.status}`);}
    const contentLength=response.headers.get('content-length');
    if(contentLength!==null&&Number(contentLength)!==manifest.archive.size) {await response.body.cancel();throw new ArtifactError('INTEGRITY_ERROR','Archive length differs from manifest');}
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try {
      while(true) {signal.throwIfAborted();const chunk=await reader.read();if(chunk.done) break;size+=chunk.value.length;
        if(size>manifest.archive.size) throw new ArtifactError('INTEGRITY_ERROR','Archive exceeds signed size');chunks.push(chunk.value);}
    } catch(error){await reader.cancel().catch(()=>{});throw error;} finally {reader.releaseLock();}
    const bytes=Buffer.concat(chunks,size);
    if(size!==manifest.archive.size||sha256(bytes)!==manifest.archive.sha256) throw new ArtifactError('INTEGRITY_ERROR','Archive integrity check failed');return bytes;
  }
  throw new ArtifactError('DOWNLOAD_FAILED','Too many redirects');
}
/** No compiler fallback. M1 uses a private per-user cache; hostile same-user processes are outside its threat model. */
export async function resolveArtifact(options: ResolveOptions): Promise<{directory:string;cacheHit:boolean}> {
  const manifest=verifyManifest(options.envelope,options.trustRoots,options.expected);
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  await mkdir(options.cacheRoot,{recursive:true,mode:0o700});
  const rootStat=await lstat(options.cacheRoot);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory()) throw new ArtifactError('UNSAFE_CACHE','Cache root is not a directory');
  const root=await realpath(options.cacheRoot);const destination=join(root,manifest.archive.sha256);
  if(await exists(destination)) {await validateCache(destination,manifest);return {directory:destination,cacheHit:true};}
  if(options.offline) throw new ArtifactError('MISSING_ARTIFACT',`No verified cache entry for ${manifest.identity.target}; offline mode never builds from source`);
  const lockPath=join(root,manifest.archive.sha256+'.lock');let lock;
  while(!lock) {
    signal.throwIfAborted();
    try {lock=await open(lockPath,'wx',0o600);} catch(e){if(code(e)!=='EEXIST') throw e;await delay(25,undefined,{signal});}
  }
  let stage:string|undefined;
  try {
    if(await exists(destination)) {await validateCache(destination,manifest);return {directory:destination,cacheHit:true};}
    const bytes=await download(manifest,options,signal);const members=readTar(bytes);
    const expected=new Map(manifest.files.map(f=>[f.path,f]));
    if(members.length!==expected.size) throw new ArtifactError('INTEGRITY_ERROR','Archive inventory mismatch');
    for(const member of members) {
      const file=expected.get(member.path);
      if(!file||file.size!==member.bytes.length||sha256(member.bytes)!==file.sha256) throw new ArtifactError('INTEGRITY_ERROR','Archive member differs from signed manifest');
    }
    stage=await mkdtemp(join(root,'.'+manifest.archive.sha256+'.stage-'));
    for(const member of members) {
      signal.throwIfAborted();const path=join(stage,member.path);await mkdir(dirname(path),{recursive:true,mode:0o700});
      const file=await open(path,'wx',0o600);try {await file.writeFile(member.bytes);await file.sync();} finally {await file.close();}
      await chmod(path,expected.get(member.path)!.executable?0o700:0o600);
    }
    await validateCache(stage,manifest);signal.throwIfAborted();await rename(stage,destination);stage=undefined;
    return {directory:destination,cacheHit:false};
  } finally {
    if(stage) await rm(stage,{recursive:true,force:true});await lock.close();await rm(lockPath,{force:true});
  }
}
