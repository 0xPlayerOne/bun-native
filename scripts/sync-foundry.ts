import { nativeHookInvocation } from './native-pre-commit.ts'
/** Run upstream Code Foundry, then apply Bunly's deterministic repository overlay. */
import { access, chmod, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Verified release source, not a floating tag resolved during CI execution. */
export const FOUNDRY_SOURCE = '0b5374bc59599b53e298bcf461d7727a9938b3ae'
export const FOUNDRY_VERSION = '1.48.2'
export const BILLING_GUARD = "vars.CI_BILLING_PAUSED != 'true'"
/** While the checked-in pause is enabled, only an explicit remote false can run jobs. */
export const PAUSED_BILLING_GUARD = "vars.CI_BILLING_PAUSED == 'false'"
/** Explicit maintainer dispatch is independent of the automatic-CI budget switch. */
export const MANUAL_DISPATCH_GUARD = "github.event_name == 'workflow_dispatch'"

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected YAML mapping')
  return value as Record<string, unknown>
}

/** A leading guard must apply to the whole expression, not only one side of an OR. */
function hasTopLevelOr(expression: string): boolean {
  let depth = 0
  let quoted = false
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index]
    if (char === "'") {
      if (quoted && expression[index + 1] === "'") {
        index++
        continue
      }
      quoted = !quoted
    } else if (!quoted) {
      if (char === '(') depth++
      if (char === ')' && --depth < 0) throw new Error('Unbalanced job condition')
      if (depth === 0 && expression.slice(index, index + 2) === '||') return true
    }
  }
  if (depth !== 0 || quoted) throw new Error('Unbalanced job condition')
  return false
}

/** Preserve authored job steps and predicates; fail rather than rewrite an unknown layout. */
export function guardWorkflow(source: string, paused = false): string {
  const workflow = record(Bun.YAML.parse(source))
  const jobs = record(workflow['jobs'])
  const desired = paused ? PAUSED_BILLING_GUARD : BILLING_GUARD
  let result = source
  for (const [name, raw] of Object.entries(jobs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error('Unsupported job name')
    const job = record(raw)
    const condition = job['if']
    if (condition === MANUAL_DISPATCH_GUARD) {
      const triggers = record(workflow['on'])
      if (!Object.hasOwn(triggers, 'workflow_dispatch'))
        throw new Error('Manual job requires an explicit workflow_dispatch trigger')
      // This exact predicate cannot run on PR, push, schedule, or workflow_call.
      // Do not accept OR expressions or weaken the ordinary billing guard.
      continue
    }
    const heading = `  ${name}:\n`
    if (result.split(heading).length !== 2) throw new Error(`Cannot locate unambiguous job ${name}`)
    if (condition === undefined) {
      result = result.replace(heading, `${heading}    if: ${desired}\n`)
      continue
    }
    if (typeof condition !== 'string')
      throw new Error(
        `Review the existing condition for job ${name} before adding its billing guard`
      )
    const expression = condition.trim()
    const previous = [BILLING_GUARD, PAUSED_BILLING_GUARD].find(
      (guard) => expression === guard || expression.startsWith(`${guard} && `)
    )
    if (!previous || hasTopLevelOr(expression))
      throw new Error(
        `Review the existing condition for job ${name} before adding its billing guard`
      )
    const start = result.indexOf(heading) + heading.length
    const rest = result.slice(start)
    const boundary = rest.search(/^(?: {0,2}\S)/m)
    const end = boundary < 0 ? result.length : start + boundary
    const block = result.slice(start, end)
    const markers = [...block.matchAll(/^    if: (?:>[-+]?\n {6})?/gm)]
    if (markers.length !== 1) throw new Error(`Review the YAML condition layout for job ${name}`)
    const marker = markers[0]!
    const offset = marker.index! + marker[0].length
    if (block.slice(offset, offset + previous.length) !== previous)
      throw new Error(`Review the YAML condition layout for job ${name}`)
    const updated = block.slice(0, offset) + desired + block.slice(offset + previous.length)
    result = result.slice(0, start) + updated + result.slice(end)
  }
  return result
}

/** Upstream templates use root directories; these native/benchmark manifests are nested. */
export function dependabotDirectories(source: string): string {
  const parsed = record(Bun.YAML.parse(source))
  if (!Array.isArray(parsed['updates'])) throw new Error('Dependabot updates are missing')
  let result = source
  const directories: Readonly<Record<string, readonly string[]>> = {
    bun: [
      '/',
      '/benchmarks/adapters/electron',
      '/benchmarks/adapters/electrobun',
      '/benchmarks/fixtures',
    ],
    cargo: ['/native', '/native/cef-host'],
  }
  for (const entry of parsed['updates']) {
    const update = record(entry)
    const ecosystem = String(update['package-ecosystem'])
    const paths = directories[ecosystem]
    if (!paths) continue
    const blocks = result.split(/(?=^  - package-ecosystem:)/m)
    let replacements = 0
    result = blocks
      .map((block) => {
        if (!block.startsWith(`  - package-ecosystem: ${ecosystem}\n`)) return block
        replacements++
        if (!/^    directory: \/$/m.test(block))
          throw new Error(`Unexpected upstream ${ecosystem} layout`)
        return block.replace(
          /^    directory: \/$/m,
          `    directories:\n${paths.map((path) => `      - ${path}`).join('\n')}`
        )
      })
      .join('')
    if (replacements !== 1) throw new Error(`Expected exactly one ${ecosystem} updater`)
  }
  return result
}

async function inspectGithubPaths(root: string): Promise<void> {
  const entries = await readdir(root)
  const misplacedNames = new Set([
    '.guthub',
    'workflows',
    'issue_template',
    'pull_request_template',
    'codeowners',
    'contributing.md',
    'code_of_conduct.md',
    'security.md',
    'pull_request_template.md',
  ])
  for (const entry of entries) {
    if (misplacedNames.has(entry.toLowerCase()))
      throw new Error(`Misplaced GitHub content: ${entry}; consolidate under .github/`)
    if (entry.toLowerCase() === '.github' && entry !== '.github')
      throw new Error('Non-canonical .github directory casing')
  }
  if (!entries.includes('.github')) return
  if ((await lstat(resolve(root, '.github'))).isSymbolicLink())
    throw new Error('Linked .github directory is not supported')
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })
    if (new Set(children.map((entry) => entry.name.toLowerCase())).size !== children.length)
      throw new Error(`Case-colliding .github paths in ${directory}`)
    for (const entry of children) {
      if (entry.name === '.github' || entry.name === '.guthub')
        throw new Error('Nested or misspelled .github directory is not supported')
      if (entry.isSymbolicLink()) throw new Error('Linked .github content is not supported')
      if (entry.isDirectory()) await visit(resolve(directory, entry.name))
    }
  }
  await visit(resolve(root, '.github'))
  const templates = resolve(root, '.github/ISSUE_TEMPLATE')
  const names = new Set<string>()
  for (const file of await readdir(templates).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })) {
    if (!/\.ya?ml$/.test(file) || file === 'config.yml') continue
    const template = record(Bun.YAML.parse(await readFile(resolve(templates, file), 'utf8')))
    const title = template['name']
    if (typeof title !== 'string' || !title.trim()) throw new Error('Missing issue form name')
    const key = title.trim().toLowerCase()
    if (names.has(key)) throw new Error(`Duplicate issue form: ${title}`)
    names.add(key)
  }
}

export async function verifyGithubLayout(root: string): Promise<void> {
  await inspectGithubPaths(root)
  for (const file of [
    'code-foundry.yml',
    'CODEOWNERS',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'PULL_REQUEST_TEMPLATE.md',
    'workflows/validation.yml',
  ]) {
    await access(resolve(root, '.github', file))
  }
}

/** Pin only the known Foundry release; a version change requires reviewed source identity. */
export function pinFoundryWorkflow(source: string): string {
  return source
    .replace(
      /(uses: 0xPlayerOne\/code-foundry\/\.github\/workflows\/[^\s@]+)@([^\s#]+)/g,
      (_match, path: string, ref: string) => {
        if (ref !== `v${FOUNDRY_VERSION}` && ref !== FOUNDRY_SOURCE)
          throw new Error('Unreviewed Code Foundry workflow source')
        return `${path}@${FOUNDRY_SOURCE}`
      }
    )
    .replace(/^(\s+runtime-ref: )([^\s#]+)$/gm, (_match, prefix: string, ref: string) => {
      if (ref !== `v${FOUNDRY_VERSION}` && ref !== FOUNDRY_SOURCE)
        throw new Error('Unreviewed Code Foundry runtime source')
      return prefix + FOUNDRY_SOURCE
    })
}

export function customizeBugReport(source: string): string {
  return source.replace(
    'Include the commit, branch, runtime/tool versions, operating system, and affected app or package.',
    'Include the commit, developer and packaged Bun versions, browser/backend version, OS/CPU, security profile, affected package, and untested platforms. Redact private page content.'
  )
}

async function checkedConfig(root: string): Promise<Record<string, unknown>> {
  const config = record(
    Bun.YAML.parse(await readFile(resolve(root, '.github/code-foundry.yml'), 'utf8'))
  )
  const pkg = record(JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')))
  const installed = record(
    JSON.parse(await readFile(resolve(root, 'node_modules/code-foundry/package.json'), 'utf8'))
  )
  if (
    record(pkg['devDependencies'])['code-foundry'] !== FOUNDRY_VERSION ||
    installed['version'] !== FOUNDRY_VERSION ||
    config['runtime_ref'] !== FOUNDRY_SOURCE ||
    config['runtime_repository'] !== '0xPlayerOne/code-foundry'
  )
    throw new Error('Code Foundry package, runtime and reviewed source pins disagree')
  if (typeof config['billing_paused'] !== 'boolean')
    throw new Error('billing_paused must be explicitly true or false')
  return config
}

/** Read-only validation of the repository overlay, in addition to upstream doctor. */
export async function verifyFoundryState(root: string): Promise<void> {
  await verifyGithubLayout(root)
  const config = await checkedConfig(root)
  const workflows = resolve(root, '.github/workflows')
  for (const name of (await readdir(workflows)).filter((name) => /\.ya?ml$/.test(name))) {
    const text = await readFile(resolve(workflows, name), 'utf8')
    if (pinFoundryWorkflow(guardWorkflow(text, config['billing_paused'] as boolean)) !== text)
      throw new Error(`Foundry overlay drift: ${name}; run bun run foundry:sync`)
  }
  const hook = await readFile(resolve(root, '.githooks/pre-commit'), 'utf8')
  if (!hook.includes(nativeHookInvocation)) throw new Error('Missing native-aware Bun commit gate')
}

export async function syncFoundry(root: string, mode: 'init' | 'sync' = 'sync'): Promise<void> {
  // Reject malformed destinations before the upstream initializer writes anything.
  await inspectGithubPaths(root)
  await checkedConfig(root)
  const cli = resolve(root, 'node_modules/code-foundry/src/cli.mjs')
  await access(cli)
  const child = Bun.spawn([process.execPath, cli, mode, '--target', root], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await child.exited) !== 0) throw new Error('Code Foundry synchronization failed')
  const config = await checkedConfig(root)
  const dependabot = resolve(root, '.github/dependabot.yml')
  await writeFile(dependabot, dependabotDirectories(await readFile(dependabot, 'utf8')))
  // Include generated callers and new custom lanes, not just the original eight workflows.
  const workflows = resolve(root, '.github/workflows')
  for (const name of (await readdir(workflows)).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const file = resolve(workflows, name)
    const before = await readFile(file, 'utf8')
    const after = pinFoundryWorkflow(guardWorkflow(before, config['billing_paused'] as boolean))
    if (before !== after) await writeFile(file, after)
  }
  const hook = resolve(root, '.githooks/pre-commit')
  const upstream = await readFile(hook, 'utf8')
  const invocation = 'exec node_modules/.bin/code-foundry pre-commit'
  if (!upstream.includes(invocation))
    throw new Error('Unexpected upstream hook; inspect before adapting it')
  await writeFile(hook, upstream.replace(invocation, nativeHookInvocation))
  await chmod(hook, 0o755)
  const bug = resolve(root, '.github/ISSUE_TEMPLATE/bug_report.yml')
  await writeFile(bug, customizeBugReport(await readFile(bug, 'utf8')))
  await verifyFoundryState(root)
  console.log(
    `Bunly overlay verified: .github layout, dependency manifests, Bun hook, and ${config['billing_paused'] ? 'paused-by-default' : 'variable-controlled'} CI jobs.`
  )
}

if (import.meta.main) {
  const mode = process.argv[2] ?? 'sync'
  if (!['init', 'sync', 'doctor'].includes(mode) || process.argv.length > 3)
    throw new Error('Use bun scripts/sync-foundry.ts [init|sync|doctor]')
  const root = resolve(import.meta.dir, '..')
  if (mode === 'doctor') {
    await verifyFoundryState(root)
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(root, 'node_modules/code-foundry/src/cli.mjs'),
        'doctor',
        '--target',
        root,
      ],
      { cwd: root, stdout: 'inherit', stderr: 'inherit' }
    )
    if (await child.exited) throw new Error('Code Foundry doctor failed')
    console.log('Bunly layout, reviewed workflow pins and native-aware gate verified.')
  } else await syncFoundry(root, mode as 'init' | 'sync')
}
