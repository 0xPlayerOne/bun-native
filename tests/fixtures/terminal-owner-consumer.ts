import assert from 'node:assert/strict'
import { Terminal } from '@xterm/headless'

/** Fixed ownership-fixture screen parser; never treats ConPTY VT output as raw JSON. */
export class OwnerTerminalConsumer {
  readonly #terminal = new Terminal({ cols: 80, rows: 24, scrollback: 256, allowProposedApi: true })
  #bytes = 0
  #record: Record<string, unknown> | undefined
  #final = false
  constructor(readonly receive: (record: Record<string, unknown>) => void) {}
  async consume(bytes: Uint8Array): Promise<void> {
    this.#bytes += bytes.byteLength
    assert.ok(this.#bytes <= 128 * 1024, 'Owner fixture output exceeded its bound')
    await new Promise<void>((resolve) => this.#terminal.write(bytes, resolve))
    const buffer = this.#terminal.buffer.active
    assert.ok(buffer.length <= 280)
    let text = ''
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index)!
      if (!line.isWrapped) text += '\n'
      text += line.translateToString(true)
    }
    assert.ok(text.length <= 128 * 1024)
    const records = [...text.matchAll(/BUNLYOWN\|([A-Za-z0-9+/=]{1,2048})\|END/g)]
    assert.ok(records.length <= 1, 'Duplicate owner readiness record')
    for (const match of records) {
      const encoded = match[1]!
      const decoded = Buffer.from(encoded, 'base64')
      assert.equal(decoded.toString('base64'), encoded)
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded))
      assert.ok(value && typeof value === 'object' && !Array.isArray(value))
      const record = value as Record<string, unknown>
      assert.equal(record['event'], 'ready')
      if (this.#record) assert.deepEqual(record, this.#record)
      else {
        this.#record = record
        this.receive(record)
      }
    }
    this.#final ||= text.includes('FINAL-' + 'x'.repeat(8192))
  }
  get final(): boolean {
    return this.#final
  }
  dispose(): void {
    this.#terminal.dispose()
  }
}

/** Console-mode Windows line input consumes Enter (CR), unlike a raw-mode Bun fixture. */
export function ownerFixtureExitInput(platform: NodeJS.Platform): Uint8Array {
  return new TextEncoder().encode(platform === 'win32' ? 'exit\r' : 'exit\n')
}
