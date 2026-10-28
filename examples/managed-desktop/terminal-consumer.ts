import type { TerminalScreen } from '../cef-terminal/terminal-records.ts'
import { TOTAL_REPLACEMENTS, byteHashText, updateByteHash } from './contract.ts'

export interface ManagedTerminal {
  readonly buffer: {
    readonly active: TerminalScreen & { readonly baseY: number; readonly cursorY: number }
  }
  write(bytes: Uint8Array, complete: () => void): void
}
export interface ManagedTerminalRecord {
  readonly sequence: number
  readonly kind: 'ready' | 'tick' | 'ack' | 'final'
  readonly revision: number
}

const pattern =
  /^BUNLYM6\|(0|[1-9][0-9]{0,4})\|(ready|tick|ack|final)\|(0|[1-9][0-9]{0,2})\|café-🐙$/
// Even a chunk of newlines cannot scroll a newly completed record out of the
// 124-line fixture screen before the next parser callback and validation.
const WRITE_BYTES = 64
interface DisplayedLine {
  text: string
  current: boolean
  clipped: boolean
}

/** Fixed fixture consumer. Credit follows actual xterm parser completion. */
export class ManagedTerminalConsumer {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  // The configured screen retains at most 124 physical lines. Keep enough
  // consumed spellings to verify every visible repaint without an unbounded log.
  readonly #recent = new Map<number, string>()
  #bytes = 0
  #hash = 0x811c9dc5
  #count = 0
  #lastAck = -1
  #final = false
  constructor(readonly terminal: ManagedTerminal) {}
  get bytes(): number {
    return this.#bytes
  }
  get hash(): string {
    return byteHashText(this.#hash)
  }
  get count(): number {
    return this.#count
  }
  get lastSequence(): number {
    return this.#count - 1
  }
  get lastAck(): number {
    return this.#lastAck
  }
  get acks(): number {
    return this.#lastAck + 1
  }
  #screen(): readonly DisplayedLine[] {
    const buffer = this.terminal.buffer.active
    if (!Number.isSafeInteger(buffer.length) || buffer.length < 0 || buffer.length > 124)
      throw new Error('TERMINAL_SCREEN_BOUND')
    const cursor = buffer.baseY + buffer.cursorY
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= buffer.length)
      throw new Error('TERMINAL_CURSOR_BOUND')
    const lines: DisplayedLine[] = []
    let size = 0
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index)
      if (!line) throw new Error('TERMINAL_SCREEN_MISSING')
      const value = line.translateToString(true)
      size += value.length
      if (value.length > 256 || size > 65_536) throw new Error('TERMINAL_TEXT_BOUND')
      const previous = lines[lines.length - 1]
      if (line.isWrapped && previous) {
        previous.text += value
        if (previous.text.length > 256) throw new Error('TERMINAL_TEXT_BOUND')
        previous.current ||= index === cursor
      } else
        lines.push({
          text: value,
          current: index === cursor,
          clipped: line.isWrapped && index === 0,
        })
    }
    return lines.filter((line) => line.text.length > 0)
  }
  #readScreen(final = false): readonly ManagedTerminalRecord[] {
    const added: ManagedTerminalRecord[] = []
    const seen = new Set<number>()
    for (const displayed of this.#screen()) {
      // A clipped first line is an old wrapped record partly evicted from
      // scrollback. Bounded writes validate new records before they can evict.
      if (displayed.clipped || (displayed.current && !final)) continue
      const line = displayed.text
      const match = pattern.exec(line)
      // The active logical row can still be receiving text or a repaint. Once
      // the cursor leaves it (or output ends), malformed rows must fail before
      // later scrolling can erase their evidence.
      if (!match) throw new Error('TERMINAL_RECORD_INVALID')
      const record: ManagedTerminalRecord = {
        sequence: Number(match[1]),
        kind: match[2] as ManagedTerminalRecord['kind'],
        revision: Number(match[3]),
      }
      if (seen.has(record.sequence)) throw new Error('TERMINAL_RECORD_DUPLICATE')
      seen.add(record.sequence)
      if (record.sequence < this.#count) {
        if (this.#recent.get(record.sequence) !== line) throw new Error('TERMINAL_RECORD_CHANGED')
        continue
      }
      if (record.sequence !== this.#count || record.sequence >= 20_000 || this.#final)
        throw new Error('TERMINAL_RECORD_ORDER')
      if ((record.sequence === 0) !== (record.kind === 'ready'))
        throw new Error('TERMINAL_READY_ORDER')
      if (record.kind === 'ack') {
        if (record.revision !== this.#lastAck + 1 || record.revision > TOTAL_REPLACEMENTS)
          throw new Error('TERMINAL_ACK_ORDER')
        this.#lastAck = record.revision
      } else if (record.revision !== 0) throw new Error('TERMINAL_RECORD_INVALID')
      if (record.kind === 'final' && this.#lastAck !== TOTAL_REPLACEMENTS)
        throw new Error('TERMINAL_INCOMPLETE')
      this.#final = record.kind === 'final'
      this.#recent.set(record.sequence, line)
      this.#count++
      if (this.#recent.size > 128) this.#recent.delete(this.#count - 129)
      added.push(Object.freeze(record))
    }
    return added
  }
  async consume(chunk: Uint8Array): Promise<readonly ManagedTerminalRecord[]> {
    if (this.#bytes + chunk.byteLength > 4 * 1024 * 1024) throw new Error('TERMINAL_BYTE_BOUND')
    const added: ManagedTerminalRecord[] = []
    for (let offset = 0; offset < chunk.byteLength; offset += WRITE_BYTES) {
      const fragment = chunk.subarray(offset, offset + WRITE_BYTES)
      await new Promise<void>((resolve) => this.terminal.write(fragment, resolve))
      this.#bytes += fragment.byteLength
      this.#hash = updateByteHash(this.#hash, fragment)
      // Every original byte reaches xterm and the cumulative integrity checks.
      // The caller receives stream credit only after all fragments complete.
      this.#decoder.decode(fragment, { stream: true })
      added.push(...this.#readScreen())
    }
    return added
  }
  finish(): void {
    if (this.#decoder.decode()) throw new Error('TERMINAL_INCOMPLETE')
    this.#readScreen(true)
    if (!this.#final || this.#lastAck !== TOTAL_REPLACEMENTS) throw new Error('TERMINAL_INCOMPLETE')
  }
}
