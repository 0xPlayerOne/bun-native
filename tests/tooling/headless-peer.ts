// Compiled headless protocol peers shared by the tooling tests in one `bun test`
// process. Each real AOT compile costs one to several seconds, so a serial run
// compiles each peer once instead of once per test or file. A file that runs in
// an isolated --parallel worker compiles its own copy on first use. The test
// preload removes this process's peers after the run (see headless-peer-cleanup.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { compileApplication } from '../../scripts/native/compile.ts'

const repository = resolve(import.meta.dir, '../..')
const protocolPeerSource = join(repository, 'tests/core/protocol-peer.ts')
const compiled = new Map<string, string>()

/** This process's peer root; removed by the test preload after the run. */
function headlessPeerRoot(): string {
  return join(repository, '.bun-native', `headless-peer-${process.pid}`)
}

export function removeHeadlessPeers(): void {
  compiled.clear()
  rmSync(headlessPeerRoot(), { recursive: true, force: true })
}

function compile(name: string, entry: (directory: string) => string): string {
  const existing = compiled.get(name)
  if (existing) return existing
  mkdirSync(headlessPeerRoot(), { recursive: true })
  const directory = mkdtempSync(join(headlessPeerRoot(), `${name}-`))
  const executable = join(directory, process.platform === 'win32' ? 'peer.exe' : 'peer')
  compileApplication(entry(directory), executable, repository)
  compiled.set(name, executable)
  return executable
}

/** The unmodified protocol peer, compiled exactly as a supplied host executable. */
export function protocolPeer(): string {
  return compile('protocol', () => protocolPeerSource)
}

/**
 * The protocol peer wrapped to record its process lifetime. Every peer process
 * reads, at startup, which log to append its started and exited records to, so
 * each test file passes and keeps its own (emptied) log.
 */
export function lifetimePeer(log: string): string {
  const executable = compile('lifetime', (directory) => {
    const entry = join(directory, 'peer.ts')
    writeFileSync(
      entry,
      `import { appendFileSync, readFileSync } from 'node:fs'\nimport { dirname, join } from 'node:path'\nconst path = readFileSync(join(dirname(process.execPath), 'lifetime-log'), 'utf8')\nconst log = (type: string) => appendFileSync(path, JSON.stringify({type,pid:process.pid})+'\\n')\nlog('started')\nprocess.on('exit',()=>log('exited'))\nawait import(${JSON.stringify(protocolPeerSource)})\n`
    )
    return entry
  })
  writeFileSync(log, '')
  writeFileSync(join(dirname(executable), 'lifetime-log'), log)
  return executable
}
