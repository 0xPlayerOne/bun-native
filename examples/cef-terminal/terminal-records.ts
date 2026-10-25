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
    for (const match of text.matchAll(/BUNLYTERM\|([0-9]{1,3})\|([A-Za-z0-9+/=]{1,8192})\|END/g)) {
      const sequence = Number(match[1])
      if (sequence >= 256 || seen.has(sequence))
        throw new Error('Duplicate or excessive displayed record')
      seen.add(sequence)
      const encoded = match[2]!
      const binary = atob(encoded)
      if (btoa(binary) !== encoded) throw new Error('Noncanonical terminal record')
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
      if (sequence < this.records.length) {
        if (JSON.stringify(value) !== JSON.stringify(this.records[sequence]!.value))
          throw new Error('A displayed record changed after consumption')
        continue
      }
      if (sequence !== this.records.length)
        throw new Error('Displayed records missing or reordered')
      const record = Object.freeze({ sequence, value: value as Record<string, unknown> })
      this.records.push(record)
      added.push(record)
    }
    return added
  }
  get unicodeObserved(): boolean {
    return this.#accent && this.#emoji
  }
}
