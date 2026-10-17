import {it} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {inspectSource,checkBoundaries} from '../scripts/check-boundaries.ts';
const root=resolve(import.meta.dirname,'..');
it('enforces current package boundaries',async()=>assert.deepEqual(await checkBoundaries(root),[]));
it('detects runtime, native, type-only and dynamic escapes in browser packages',()=>{
 const file=resolve(root,'packages/client/src/seed.ts');
 for(const source of ["import {x} from '../../runtime/src/index.ts'", "export * from '@bunly/runtime'", "import type {Foo} from 'node:fs'",
  "const x=import('bun:ffi')", "type T=import('node:fs').Stats", "const x=import(name)", "Bun.spawn(['x'])", "process.exit()"])
  assert.ok(inspectSource(file,source,root).length>0,source);
});
it('permits portable contract dependencies',()=>assert.deepEqual(inspectSource(resolve(root,'packages/client/src/ok.ts'),"import type {ViewState} from '../../contracts/src/index.ts'",root),[]));
