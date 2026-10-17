const response = await fetch('/next.html');
if (!response.ok || !(await response.text()).includes('Navigation complete')) throw new Error('Packaged fetch failed');
const missing = await fetch('/not-in-public-manifest');
if (missing.status !== 404) throw new Error('Missing resource did not fail closed');
const range = await fetch('/next.html', { headers: { Range: 'bytes=0-14' } });
if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 15) throw new Error('Range response failed');
if (typeof globalThis.Bun !== 'undefined' || typeof globalThis.require !== 'undefined' || typeof globalThis.bunly !== 'undefined') throw new Error('Native authority leaked to page');
await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
console.log('BUNLY_ASSET_TEST_OK');
