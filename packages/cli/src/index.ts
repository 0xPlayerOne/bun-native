import { readFile } from 'node:fs/promises';
import { resolveArtifact } from '../../artifacts/src/index.ts';
import type { SignedManifest, ArtifactIdentity } from '../../artifacts/src/index.ts';
export async function main(args: string[]): Promise<void> {
  if(args[0]==='doctor') {
    console.log(JSON.stringify({name:'Bunly',stage:'M1 foundation',bun:process.versions['bun']??null,
      target:`${process.platform}-${process.arch}`,nativeRuntime:'not yet implemented',cef:'M3',contractVersion:1},null,2)); return;
  }
  if(args[0]==='artifact' && args[1]==='resolve' && args.length===3) {
    const config=JSON.parse(await readFile(args[2]!,'utf8')) as {
      envelope:SignedManifest;trustRoots:Record<string,string>;expected:ArtifactIdentity;cacheRoot:string;allowedOrigins:string[];offline?:boolean};
    console.log(JSON.stringify(await resolveArtifact(config),null,2));return;
  }
  throw new Error('Usage: bun packages/cli/src/main.ts doctor | artifact resolve <trusted-local-config.json>');
}
