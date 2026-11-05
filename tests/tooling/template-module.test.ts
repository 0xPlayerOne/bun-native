import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureDevelopmentModule,
  developmentModuleCleanup,
} from '../native/cli-module-evidence.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function specimen() {
  const root = mkdtempSync(join(tmpdir(), 'native-module-evidence-'))
  directories.push(root)
  const project = join(root, 'consumer')
  const module = join(project, '.bun-native/dev-owned')
  mkdirSync(module, { recursive: true })
  writeFileSync(join(module, 'application.js'), 'inert module bytes; never executed')
  writeFileSync(join(module, 'application.js.map'), '{"version":3,"sources":[]}')
  return { root, project, module, retained: join(root, 'retained') }
}

test('ready capture retains exact bytes and requires CLI removal before successful cleanup', () => {
  const fixture = specimen()
  const captured = captureDevelopmentModule(fixture.project, fixture.retained)
  expect(captured.directory).toBe(fixture.module)
  expect(captured.artifacts).toHaveLength(2)
  for (const artifact of captured.artifacts) {
    expect(readFileSync(artifact.retained)).toEqual(readFileSync(artifact.path))
    expect(artifact.sha256).toBe(
      Bun.CryptoHasher.hash('sha256', readFileSync(artifact.path), 'hex')
    )
  }
  expect(developmentModuleCleanup(fixture.project, captured)).toEqual({
    remaining: ['dev-owned'],
    removed: false,
  })
  rmSync(fixture.module, { recursive: true })
  expect(developmentModuleCleanup(fixture.project, captured)).toEqual({
    remaining: [],
    removed: true,
  })
  expect(developmentModuleCleanup(fixture.project, undefined).removed).toBe(false)
  mkdirSync(join(fixture.project, '.bun-native/dev-late'))
  expect(developmentModuleCleanup(fixture.project, captured).removed).toBe(false)
  rmSync(join(fixture.project, '.bun-native'), { recursive: true })
  expect(developmentModuleCleanup(fixture.project, captured)).toEqual({
    remaining: [],
    removed: true,
  })
  expect(existsSync(fixture.retained)).toBe(true)
})

test('ready capture rejects ambiguous, linked, non-module and nested file owners', () => {
  for (const corrupt of [
    ({ project }: ReturnType<typeof specimen>) =>
      mkdirSync(join(project, '.bun-native/dev-second')),
    ({ module }: ReturnType<typeof specimen>) => rmSync(join(module, 'application.js')),
    ({ module }: ReturnType<typeof specimen>) => mkdirSync(join(module, 'nested')),
    ({ module, root }: ReturnType<typeof specimen>) =>
      symlinkSync(root, join(module, 'link'), 'dir'),
  ]) {
    const fixture = specimen()
    corrupt(fixture)
    expect(() => captureDevelopmentModule(fixture.project, fixture.retained)).toThrow()
    expect(existsSync(fixture.retained)).toBe(false)
  }
  const fixture = specimen()
  rmSync(fixture.module, { recursive: true })
  symlinkSync(fixture.root, fixture.module, 'dir')
  expect(() => captureDevelopmentModule(fixture.project, fixture.retained)).toThrow(
    'one temporary module'
  )
})

test('ready capture never overwrites an existing evidence directory', () => {
  const fixture = specimen()
  mkdirSync(fixture.retained)
  writeFileSync(join(fixture.retained, 'application.js'), 'preserved previous evidence')
  expect(() => captureDevelopmentModule(fixture.project, fixture.retained)).toThrow()
  expect(readFileSync(join(fixture.retained, 'application.js'), 'utf8')).toBe(
    'preserved previous evidence'
  )
})
