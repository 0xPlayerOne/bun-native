import { readFile } from 'node:fs/promises';
import { inspectArtifact, resolveArtifact } from '../../artifacts/src/index.ts';
import type { ResolveOptions } from '../../artifacts/src/index.ts';
export async function main(args: string[]): Promise<void> {
  if(args[0]==='doctor') {
    console.log(JSON.stringify({name:'Bunly',stage:'M1 foundation',bun:process.versions['bun']??null,
      target:`${process.platform}-${process.arch}`,nativeRuntime:'not yet implemented',cef:'M3',contractVersion:1},null,2)); return;
  }
  if(args[0]==='artifact' && (args[1]==='resolve' || args[1]==='inspect') && args.length===3) {
    const config=JSON.parse(await readFile(args[2]!,'utf8')) as Omit<ResolveOptions, 'signal' | 'fetcher'>;
    const result=args[1]==='inspect'?await inspectArtifact(config):await resolveArtifact(config);
    console.log(JSON.stringify(result,null,2));return;
  }
  throw new Error('Usage: bun packages/cli/src/main.ts doctor | artifact resolve|inspect <trusted-local-config.json>');
}
