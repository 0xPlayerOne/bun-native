import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const uploadCases = ['text', 'maximum', 'empty', 'isolated', 'drop'] as const
export type UploadCase = (typeof uploadCases)[number]
export interface UploadReceipt {
  readonly case: UploadCase
  readonly name: string
  readonly mime: string
  readonly bytes: number
  readonly sha256: string
  readonly cookie: string
  readonly kind: 'file-input' | 'file-drop'
  readonly trusted: false
}
const documents = new Set<string>([
  ...uploadCases,
  'denied',
  'cancel',
  'reload',
  'navigating',
  'replacement',
  'closing',
  'partial',
])
const html = (
  name: string
) => `<!doctype html><meta charset="utf-8"><title>Programmatic files fixture</title>
<input id="upload" type="file"><input id="other" type="file"><div id="drop">Synthetic drop target</div>
<script>
const name=${JSON.stringify(name)}, input=document.getElementById('upload'), drop=document.getElementById('drop');
const send=(file,kind,event)=>{
  const data=new FormData(); data.append('file',file); data.append('kind',kind); data.append('trusted',String(event.isTrusted));
  fetch('/upload/'+name,{method:'POST',body:data,credentials:'same-origin'});
};
input.addEventListener('input',event=>{
  if(name!=='partial') return;
  const file=input.files[0];
  fetch('/exposed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,mime:file.type,bytes:file.size,trusted:event.isTrusted})});
  input.replaceWith(input.cloneNode());
});
input.addEventListener('change',event=>send(input.files[0],'file-input',event));
drop.addEventListener('dragover',event=>event.preventDefault());
drop.addEventListener('drop',event=>{event.preventDefault();send(event.dataTransfer.files[0],'file-drop',event)});
</script>`

/** Bun's multipart parser infers File.type from the filename on some versions.
 * Inspect the actual first part header so acceptance measures the wire MIME. */
async function uploadedWireMime(request: Request, name: UploadCase): Promise<string> {
  const contentType = request.headers.get('content-type') ?? ''
  const boundary = /^multipart\/form-data;\s*boundary=([A-Za-z0-9'()+_,.=:?-]{1,70})$/i.exec(
    contentType
  )?.[1]
  assert.ok(boundary, 'Invalid multipart boundary')
  const bytes = Buffer.from(await request.clone().arrayBuffer())
  assert.ok(bytes.length <= 1024 * 1024 + 32 * 1024, 'Multipart fixture exceeds its bound')
  const prefix = Buffer.from(`--${boundary}\r\n`)
  assert.ok(bytes.subarray(0, prefix.length).equals(prefix), 'File part must be first')
  const end = bytes.indexOf('\r\n\r\n', prefix.length)
  assert.ok(end >= prefix.length && end - prefix.length <= 1024, 'Invalid file part headers')
  const headers = bytes.subarray(prefix.length, end).toString('latin1').split('\r\n')
  assert.equal(headers.length, 2, 'Unexpected file part headers')
  assert.equal(headers[0], `Content-Disposition: form-data; name="file"; filename="${name}.bin"`)
  const media =
    /^Content-Type: ([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)(?:;\s*charset=utf-8)?$/i.exec(
      headers[1]!
    )?.[1]
  assert.ok(media, 'Invalid file part media type')
  return media.toLowerCase()
}

/** A bounded temporary HTTP peer. It accepts only this fixture's known cases,
 * and retains receipts rather than received file payloads or filesystem paths.
 */
export function fileFixtureServer() {
  const receipts = new Map<UploadCase, UploadReceipt>()
  const waiters = new Map(
    uploadCases.map((name) => [name, Promise.withResolvers<UploadReceipt>()] as const)
  )
  const exposure = Promise.withResolvers<Readonly<Record<string, unknown>>>()
  let exposed = false
  const failures: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      try {
        const path = new URL(request.url).pathname
        if (request.method === 'GET' && path.startsWith('/document/')) {
          const name = path.slice('/document/'.length)
          if (!documents.has(name)) return new Response('Missing fixture', { status: 404 })
          return new Response(html(name), {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          })
        }
        if (request.method === 'POST' && path === '/exposed') {
          assert.equal(exposed, false)
          const raw = await request.text()
          assert.ok(Buffer.byteLength(raw) <= 1024)
          const value = JSON.parse(raw) as Record<string, unknown>
          assert.deepEqual(Object.keys(value).sort(), ['bytes', 'mime', 'name', 'trusted'])
          assert.equal(value['name'], 'partial.txt')
          assert.equal(value['mime'], 'text/plain')
          assert.equal(value['bytes'], 7)
          assert.equal(value['trusted'], false)
          exposed = true
          exposure.resolve(Object.freeze(value))
          return new Response('ok')
        }
        if (request.method !== 'POST' || !path.startsWith('/upload/'))
          return new Response('Missing fixture', { status: 404 })
        const name = path.slice('/upload/'.length) as UploadCase
        assert.ok(uploadCases.includes(name))
        assert.equal(receipts.has(name), false, 'A fixture upload must arrive once')
        const mime = await uploadedWireMime(request, name)
        const data = await request.formData()
        assert.deepEqual([...data.keys()].sort(), ['file', 'kind', 'trusted'])
        const file = data.get('file')
        assert.ok(file instanceof File)
        assert.ok(file.size <= 1024 * 1024)
        const kind = data.get('kind')
        assert.ok(kind === 'file-input' || kind === 'file-drop')
        assert.equal(data.get('trusted'), 'false')
        const cookie = request.headers.get('cookie')
        assert.ok(cookie === 'partition=alpha' || cookie === 'partition=beta')
        const receipt = Object.freeze({
          case: name,
          name: file.name,
          mime,
          bytes: file.size,
          sha256: createHash('sha256')
            .update(new Uint8Array(await file.arrayBuffer()))
            .digest('hex'),
          cookie,
          kind,
          trusted: false as const,
        })
        // Synchronous admission above and this second check also reject two
        // concurrent requests for the same known fixture case.
        assert.equal(receipts.has(name), false)
        receipts.set(name, receipt)
        waiters.get(name)!.resolve(receipt)
        return new Response('ok')
      } catch {
        if (failures.length < 8) failures.push('invalid-fixture-request')
        return new Response('Invalid fixture request', { status: 400 })
      }
    },
  })
  return {
    origin: server.url.origin,
    url: (name: string) => {
      assert.ok(documents.has(name))
      return server.url.origin + '/document/' + name
    },
    receipt: (name: UploadCase) => waiters.get(name)!.promise,
    exposure: exposure.promise,
    snapshot: () => ({ uploads: [...receipts.values()], exposed, failures: [...failures] }),
    stop: () => server.stop(true),
  }
}
