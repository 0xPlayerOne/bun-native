import assert from 'node:assert/strict'
import { Terminal } from '@xterm/headless'

/** Contributor-only real terminal parser. No ad-hoc ANSI stripping or app runtime dependency. */
export class QualificationTerminal {
  readonly #terminal = new Terminal({
    cols: 100,
    rows: 30,
    scrollback: 256,
    allowProposedApi: true,
  })
  readonly records: Record<string, unknown>[] = []
  #sawAccent = false
  #sawEmoji = false
  #disposed = false
  constructor(readonly receive: (record: Record<string, unknown>) => void) {}
  resize(cols: number, rows: number): void {
    this.#terminal.resize(cols, rows)
  }
  async consume(bytes: Uint8Array): Promise<void> {
    assert.equal(this.#disposed, false)
    await new Promise<void>((resolve) => this.#terminal.write(bytes, resolve))
    assert.equal(this.#disposed, false)
    const buffer = this.#terminal.buffer.active
    assert.ok(buffer.length <= 256 + this.#terminal.rows)
    let text = ''
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index)!
      if (!line.isWrapped) text += '\n'
      text += line.translateToString(true)
    }
    assert.ok(text.length <= 128 * 1024)
    this.#sawAccent ||= text.includes('café')
    this.#sawEmoji ||= text.includes('🐙')
    const seen = new Set<number>()
    for (const match of text.matchAll(/BUNLYPTY\|([0-9]{1,3})\|([A-Za-z0-9+/=]{1,1024})\|END/g)) {
      const sequence = Number(match[1])
      assert.ok(
        sequence < 80 && !seen.has(sequence),
        'Duplicate or excessive displayed fixture record'
      )
      seen.add(sequence)
      const encoded = match[2]!
      const bytes = Buffer.from(encoded, 'base64')
      assert.equal(bytes.toString('base64'), encoded)
      const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      assert.ok(record && typeof record === 'object' && !Array.isArray(record))
      assert.equal(typeof (record as Record<string, unknown>)['type'], 'string')
      if (sequence < this.records.length) {
        // A new screen snapshot includes previously validated rows; they are
        // checked, not counted again. xterm resolves cursor repaint semantics.
        assert.deepEqual(record, this.records[sequence])
        continue
      }
      assert.equal(
        sequence,
        this.records.length,
        'Displayed fixture records are missing or reordered'
      )
      this.records.push(record as Record<string, unknown>)
      this.receive(record as Record<string, unknown>)
    }
  }
  get unicodeObserved(): boolean {
    return this.#sawAccent && this.#sawEmoji
  }
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#terminal.dispose()
  }
}
