/** Dedicated binary stream framing. Never feed these packets into the RPC decoder. */
export const STREAM_VERSION = 1;
export const STREAM_HEADER_BYTES = 24;
export const STREAM_CHUNK_BYTES = 16 * 1024;
const MAGIC = 0x424c5354; // BLST, network byte order.
const KINDS = ['open', 'opened', 'data', 'ack', 'close', 'closed', 'cancel', 'error'] as const;
export type StreamKind = typeof KINDS[number];
export const STREAM_ERRORS = ['CANCELLED', 'DISCONNECTED', 'OVERLOADED', 'PROTOCOL_ERROR', 'FORBIDDEN', 'CONSUMER_FAILED', 'DEADLINE_EXCEEDED'] as const;
export type StreamErrorCode = typeof STREAM_ERRORS[number];
export class StreamError extends Error {
  constructor(readonly code: StreamErrorCode, message = `Stream ${code.toLowerCase().replaceAll('_', ' ')}`) { super(message); this.name = 'StreamError'; }
}
export interface StreamFrame {
  readonly kind: StreamKind;
  readonly id: number;
  readonly sequence: number;
  readonly argument: number;
  /** Borrowed while decoding; a consumer retaining bytes must make a bounded copy. */
  readonly body: Uint8Array;
}
const EMPTY = new Uint8Array();
export function streamFrame(kind: StreamKind, id: number, sequence = 0, argument = 0, body: Uint8Array = EMPTY): StreamFrame {
  return { kind, id, sequence, argument, body };
}
function invalid(): never { throw new StreamError('PROTOCOL_ERROR'); }
export function validateChunkSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 128 || value > 1024 * 1024) throw new TypeError('Stream chunks must be 128–1048576 bytes');
}
function uint32(n: number): boolean { return Number.isInteger(n) && n >= 0 && n <= 0xffffffff; }
function validate(frame: StreamFrame, maxChunkBytes: number): void {
  if (!KINDS.includes(frame.kind) || !uint32(frame.id) || !frame.id || !uint32(frame.sequence) || !uint32(frame.argument) ||
      !(frame.body instanceof Uint8Array) || !(frame.body.buffer instanceof ArrayBuffer)) invalid();
  const { kind, sequence, argument, body } = frame;
  if (kind === 'data') { if (!sequence || !body.length || body.length > maxChunkBytes || argument) invalid(); }
  else if (kind === 'open') {
    if (sequence || argument || !body.length || body.length > 128) invalid();
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return invalid(); }
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) invalid();
  } else {
    if (body.length) invalid();
    if (kind === 'ack') { if (!sequence || !argument || argument > maxChunkBytes) invalid(); }
    else if (kind === 'error') { if (sequence || argument < 1 || argument > STREAM_ERRORS.length) invalid(); }
    else if (kind === 'close' || kind === 'closed') { if (argument) invalid(); }
    else if (sequence || argument) invalid();
  }
}
export function encodeStream(frame: StreamFrame, maxChunkBytes = STREAM_CHUNK_BYTES): Uint8Array {
  validateChunkSize(maxChunkBytes); validate(frame, maxChunkBytes);
  const bytes = new Uint8Array(STREAM_HEADER_BYTES + frame.body.length), header = new DataView(bytes.buffer);
  header.setUint32(0, MAGIC); header.setUint8(4, STREAM_VERSION); header.setUint8(5, KINDS.indexOf(frame.kind));
  header.setUint32(8, frame.id); header.setUint32(12, frame.sequence); header.setUint32(16, frame.body.length); header.setUint32(20, frame.argument);
  bytes.set(frame.body, STREAM_HEADER_BYTES); return bytes;
}
function packetLength(bytes: Uint8Array, maxChunkBytes: number): number {
  const h = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (h.getUint32(0) !== MAGIC || h.getUint8(4) !== STREAM_VERSION || h.getUint8(5) >= KINDS.length || h.getUint16(6)) invalid();
  const length = h.getUint32(16), kind = KINDS[h.getUint8(5)];
  if (length > (kind === 'data' ? maxChunkBytes : kind === 'open' ? 128 : 0)) invalid();
  return STREAM_HEADER_BYTES + length;
}
export function decodeStream(bytes: Uint8Array, maxChunkBytes = STREAM_CHUNK_BYTES): StreamFrame {
  validateChunkSize(maxChunkBytes);
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.length < STREAM_HEADER_BYTES ||
      bytes.length !== packetLength(bytes, maxChunkBytes)) invalid();
  const h = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frame = streamFrame(KINDS[h.getUint8(5)]!, h.getUint32(8), h.getUint32(12), h.getUint32(20), bytes.subarray(STREAM_HEADER_BYTES));
  validate(frame, maxChunkBytes); return frame;
}
/** Incremental framing for future pipe/socket adapters: one bounded partial packet, no output queue. */
export class StreamFramer {
  #buffer = new Uint8Array(STREAM_HEADER_BYTES);
  #used = 0;
  #ended = false;
  #pushing = false;
  constructor(readonly deliver: (packet: Uint8Array) => void, readonly maxChunkBytes = STREAM_CHUNK_BYTES) { validateChunkSize(maxChunkBytes); }
  push(input: Uint8Array): void {
    if (this.#ended || this.#pushing || !(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) invalid();
    this.#pushing = true;
    try {
      let offset = 0;
      while (offset < input.length) {
        const take = Math.min(this.#buffer.length - this.#used, input.length - offset);
        this.#buffer.set(input.subarray(offset, offset + take), this.#used); this.#used += take; offset += take;
        if (this.#used !== this.#buffer.length) continue;
        const length = packetLength(this.#buffer, this.maxChunkBytes);
        if (length > this.#buffer.length) { const full = new Uint8Array(length); full.set(this.#buffer); this.#buffer = full; continue; }
        const packet = this.#buffer; decodeStream(packet, this.maxChunkBytes);
        this.#buffer = new Uint8Array(STREAM_HEADER_BYTES); this.#used = 0; this.deliver(packet);
        if (this.#ended) invalid();
      }
    } catch (error) { this.#ended = true; this.#buffer = EMPTY; this.#used = 0; throw error; }
    finally { this.#pushing = false; }
  }
  finish(): void { if (this.#ended || this.#used) { this.dispose(); invalid(); } this.dispose(); }
  dispose(): void { this.#ended = true; this.#buffer = EMPTY; this.#used = 0; }
  diagnostics(): number { return this.#buffer.length; }
}

/** Adapter helper: short writes must advance, or fail. StreamLink supplies the drain watchdog. */
export async function writeStreamPacket(packet: Uint8Array, write: (bytes: Uint8Array) => number | Promise<number>, maxChunkBytes = STREAM_CHUNK_BYTES): Promise<void> {
  decodeStream(packet, maxChunkBytes);
  let offset = 0;
  while (offset < packet.length) {
    const remaining = packet.subarray(offset), written = await write(remaining);
    if (!Number.isSafeInteger(written) || written <= 0 || written > remaining.length) throw new StreamError('DISCONNECTED');
    offset += written;
  }
}
