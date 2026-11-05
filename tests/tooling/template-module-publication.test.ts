import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { captureDevelopmentModule } from '../native/cli-module-evidence.ts'

function specimen() {
  const root = fs.mkdtempSync(join(tmpdir(), 'native-module-publication-'))
  const project = join(root, 'consumer')
  const module = join(project, '.bun-native/dev-owned')
  const retained = join(root, 'retained')
  fs.mkdirSync(module, { recursive: true })
  const contents = {
    'application.js': 'inert captured module; never executed',
    'application.js.map': '{"version":3,"sources":[]}',
  }
  for (const [name, content] of Object.entries(contents))
    fs.writeFileSync(join(module, name), content)
  return { root, project, module, retained, contents }
}

test('publishing the retained entry cannot race removal of its remaining source files', () => {
  const fixture = specimen()
  const copy = fs.copyFileSync
  const rename = fs.renameSync
  let closed = false
  // A consumer observes the same entry-file publication barrier used by the
  // real headless CLI fixture, then immediately removes its generated module.
  // Interception makes that legal interleaving deterministic, without sleeps.
  const observe = () => {
    if (!closed && fs.existsSync(join(fixture.retained, 'application.js'))) {
      closed = true
      fs.rmSync(fixture.module, { recursive: true })
    }
  }
  const copying = spyOn(fs, 'copyFileSync').mockImplementation((...args) => {
    copy(...args)
    observe()
  })
  const renaming = spyOn(fs, 'renameSync').mockImplementation((...args) => {
    rename(...args)
    observe()
  })
  try {
    const captured = captureDevelopmentModule(fixture.project, fixture.retained)
    expect(closed).toBe(true)
    expect(fs.existsSync(fixture.module)).toBe(false)
    expect(captured.artifacts).toHaveLength(2)
    expect(fs.readdirSync(fixture.retained).sort()).toEqual(Object.keys(fixture.contents))
    for (const [name, content] of Object.entries(fixture.contents)) {
      const artifact = captured.artifacts.find((item) => basename(item.retained) === name)
      expect(artifact?.sha256).toBe(Bun.CryptoHasher.hash('sha256', content, 'hex'))
      expect(fs.readFileSync(join(fixture.retained, name), 'utf8')).toBe(content)
    }
  } finally {
    copying.mockRestore()
    renaming.mockRestore()
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a partial or mismatched copy never publishes the retained entry', () => {
  const fixture = specimen()
  const copying = spyOn(fs, 'copyFileSync').mockImplementation((_source, destination) => {
    fs.writeFileSync(destination, '')
    expect(fs.existsSync(join(fixture.retained, 'application.js'))).toBe(false)
    fs.writeFileSync(destination, 'partial')
    expect(fs.existsSync(join(fixture.retained, 'application.js'))).toBe(false)
  })
  try {
    expect(() => captureDevelopmentModule(fixture.project, fixture.retained)).toThrow(
      'Retained dev module differs from the running module'
    )
    expect(fs.existsSync(fixture.retained)).toBe(false)
    expect(fs.readdirSync(fixture.root)).toEqual(['consumer'])
    expect(fs.readFileSync(join(fixture.module, 'application.js'), 'utf8')).toBe(
      fixture.contents['application.js']
    )
  } finally {
    copying.mockRestore()
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})
