import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { inspectCefLibrary } from '../benchmarks/lib/cef-identity.ts';
const [library, sha256, filename] = process.argv.slice(2);
if (!library || !sha256 || !filename) throw new Error('Usage: bun scripts/inspect-cef-artifact.ts <trusted-installed-library> <sha256> <report.json>');
const output = resolve(filename); await mkdir(dirname(output), { recursive: true });
const identity = await inspectCefLibrary(library, sha256, output + '.process.json');
await writeFile(output, JSON.stringify(identity, null, 2) + '\n');
console.log(JSON.stringify(identity));
