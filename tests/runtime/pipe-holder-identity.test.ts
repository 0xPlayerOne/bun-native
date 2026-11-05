import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishHolderIdentity } from './pipe-holder-identity.ts'

test.each(['started', 'ready', 'finished'] as const)(
  'publishes the complete %s identity only after its file is written',
  (phase) => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'bun-native-identity-'))
    const destination = join(directory, phase)
    const write = fs.writeFileSync
    const observations: boolean[] = []
    // Expose the real create-before-write boundary deterministically. This is
    // an intercepted filesystem operation, not a native-process qualification.
    const intercepted = spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
      write(path, '', options)
      observations.push(fs.existsSync(destination))
      write(path, String(data).slice(0, 1))
      observations.push(fs.existsSync(destination))
      write(path, data)
    })
    try {
      publishHolderIdentity(directory, phase)
      expect(intercepted).toHaveBeenCalledTimes(1)
      expect(observations).toEqual([false, false])
      expect(fs.readFileSync(destination, 'utf8')).toBe(String(process.pid))
      expect(fs.readdirSync(directory)).toEqual([phase])
    } finally {
      intercepted.mockRestore()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
)
