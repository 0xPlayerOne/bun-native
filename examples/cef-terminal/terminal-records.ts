/** Read actual xterm screen state after parser completion; never strip raw VT bytes. */
export interface TerminalScreen {
  readonly length: number
  getLine(
    index: number
  ): { readonly isWrapped: boolean; translateToString(trimRight: boolean): string } | undefined
}
export interface ParsedRecord {
  readonly sequence: number
  readonly value: Record<string, unknown>
}
export class TerminalRecords {
  readonly records: ParsedRecord[] = []
  // btoa creates the canonical record spelling independently of a potentially
  // large screen string. Keep the same finite rolling window as parsed records.
  readonly #encoded: string[] = []
  #next = 0
  #base = 0
  constructor(readonly limits = { maxRecords: 256, retainedRecords: 256 }) {
    if (
      !Number.isSafeInteger(limits.maxRecords) ||
      limits.maxRecords < 1 ||
      limits.maxRecords > 100000 ||
      !Number.isSafeInteger(limits.retainedRecords) ||
      limits.retainedRecords < 1 ||
      limits.retainedRecords > 600
    )
      throw new Error('Invalid terminal record retention bounds')
  }
  get count(): number {
    return this.#next
  }
  #accent = false
  #emoji = false
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  update(buffer: TerminalScreen): readonly ParsedRecord[] {
    if (!Number.isSafeInteger(buffer.length) || buffer.length < 0 || buffer.length > 600)
      throw new Error('Terminal screen exceeded its line bound')
    let text = ''
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index)
      if (!line) throw new Error('Missing terminal screen line')
      const value = line.translateToString(true)
      if (value.length > 1000 || text.length + value.length + 1 > 256 * 1024)
        throw new Error('Terminal screen exceeded its text bound')
      if (!line.isWrapped) text += '\n'
      text += value
    }
    this.#accent ||= text.includes('café')
    this.#emoji ||= text.includes('🐙')
    const added: ParsedRecord[] = []
    const seen = new Set<number>()
    for (const match of text.matchAll(/BUNLYTERM\|([0-9]{1,6})\|([A-Za-z0-9+/=]{1,8192})\|END/g)) {
      const sequence = Number(match[1])
      if (sequence >= this.limits.maxRecords || seen.has(sequence))
        throw new Error('Duplicate or excessive displayed record')
      seen.add(sequence)
      const encoded = match[2]!
      if (sequence < this.#next) {
        const index = sequence - this.#base
        if (this.records[index]?.sequence !== sequence || this.#encoded[index] !== encoded)
          throw new Error('A displayed record changed after consumption')
        continue
      }
      if (sequence !== this.#next) throw new Error('Displayed records missing or reordered')
      const binary = atob(encoded)
      const canonical = btoa(binary)
      if (canonical !== encoded) throw new Error('Noncanonical terminal record')
      const value: unknown = JSON.parse(
        this.#decoder.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
      )
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof (value as Record<string, unknown>)['type'] !== 'string'
      )
        throw new Error('Malformed terminal record')
      const record = Object.freeze({ sequence, value: value as Record<string, unknown> })
      this.records.push(record)
      this.#encoded.push(canonical)
      this.#next++
      if (this.records.length > this.limits.retainedRecords) {
        this.records.shift()
        this.#encoded.shift()
        this.#base++
      }
      added.push(record)
    }
    return added
  }
  get unicodeObserved(): boolean {
    return this.#accent && this.#emoji
  }
}

/** Verify the fixed workload's semantics, not merely matching two dynamic hashes. */
export function verifyFixedRecordPayloads(records: readonly ParsedRecord[], count: number): true {
  if (!Number.isSafeInteger(count) || count < 1 || count > 2048 || records.length > 256)
    throw new Error('Invalid fixed record bounds')
  const payloads = records.filter((record) => record.value['type'] === 'record')
  if (payloads.length !== count) throw new Error('Missing or excessive fixed payloads')
  for (let index = 0; index < payloads.length; index++) {
    const value = payloads[index]!.value
    if (
      Object.keys(value).sort().join(',') !== 'index,text,type' ||
      value['index'] !== index ||
      value['text'] !== `fixed-${index}-café-🐙`
    )
      throw new Error('Fixed terminal payload changed or reordered')
  }
  return true
}
