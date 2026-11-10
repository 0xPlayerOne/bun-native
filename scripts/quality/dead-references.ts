import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'

/**
 * Dead-reference gate: package.json scripts, GitHub workflows and git hooks
 * must not name repository paths that no longer exist. Extraction is
 * deliberately conservative: only tokens that start with a known top-level
 * repository directory (or `./`) are checked, so prose, URLs, branch names,
 * package specifiers and remote reusable workflows never become findings.
 */

export type Reference = { source: string; path: string }

// Top-level directories whose mention clearly means "a file in this repository".
const repositoryPrefixes = [
  'scripts/',
  'tests/',
  'native/',
  'packages/',
  'examples/',
  'benchmarks/',
  'experiments/',
  'docs/',
  '.github/',
  '.githooks/',
  './',
]

// Path segments that name build output or installed dependencies. They are
// created by the commands that reference them, so they are never dead.
const generatedSegments = new Set([
  'target', // cargo build output
  'dist', // bundler output
  'node_modules', // installed dependencies
  '.bun-native', // local evidence, caches and downloaded performance sources
])

// Tokens split on whitespace and shell/YAML punctuation. `/`, `.`, `-`, `_`,
// `*`, `?`, `{`, `}`, `[`, `]` and `$` stay inside a token so globs and
// variables survive long enough to be recognized and handled. Redirections
// are kept as their own tokens because they mark the next path as output.
const tokenPattern = />>?|[^\s'"`,;|&<>()=:]+/g

// Arguments that introduce a path the same step creates.
const outputFlags = new Set(['-o', '--out', '--output', '--outdir', '--out-dir', '--destination'])
const outputCommands = new Set(['mkdir', 'tee', 'touch'])

const portable = (path: string) => path.split(sep).join('/')

/** Replace `${{ ... }}` expressions so text around them never forms a path token. */
function stripExpressions(text: string): string {
  return text.replace(/\$\{\{[\s\S]*?\}\}/g, '\u0000')
}

/** Blank YAML trigger filters whose values are branch or tag names, not paths. */
export function stripRefFilters(yaml: string): string {
  const lines = yaml.split(/\r?\n/)
  let filterIndent = -1
  return lines
    .map((line) => {
      const indent = line.length - line.trimStart().length
      if (filterIndent >= 0) {
        const item = indent === filterIndent && /^\s*-\s/.test(line)
        if (line.trim() === '' || indent > filterIndent || item) return ''
        filterIndent = -1
      }
      const match = /^(\s*)(?:branches|branches-ignore|tags|tags-ignore)\s*:(.*)$/.exec(line)
      if (!match) return line
      if ((match[2] ?? '').trim() === '') filterIndent = (match[1] ?? '').length
      return ''
    })
    .join('\n')
}

function normalize(token: string): string | undefined {
  let path = token.replace(/[.,:;!?)\]}]+$/, '') // trailing sentence punctuation
  if (path.includes('$') || path.includes('\u0000') || path.includes('\\')) return undefined
  if (!repositoryPrefixes.some((prefix) => path.startsWith(prefix))) return undefined
  if (path.startsWith('./')) path = path.slice(2)
  path = posix.normalize(path).replace(/\/+$/, '')
  if (path === '.' || path === '' || path.startsWith('..')) return undefined
  return path
}

function isGenerated(path: string, outputs: readonly string[]): boolean {
  if (path.split('/').some((segment) => generatedSegments.has(segment))) return true
  return outputs.some((output) => path === output || path.startsWith(output + '/'))
}

/** Extract repository path references from one shell-like snippet (one step or script). */
export function extractReferences(text: string): string[] {
  const tokens = stripExpressions(text).match(tokenPattern) ?? []
  const outputs: string[] = []
  const candidates: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string
    const path = normalize(token)
    if (!path) continue
    const previous = tokens.slice(Math.max(0, index - 2), index)
    const last = previous.at(-1) ?? ''
    const createdHere =
      previous.some((word) => outputCommands.has(word)) ||
      outputFlags.has(last) ||
      last.startsWith('>')
    if (createdHere) outputs.push(path)
    else candidates.push(path)
  }
  const references = candidates.filter((path) => !isGenerated(path, outputs))
  return [...new Set(references)]
}

/** Split a workflow into steps so "created earlier in this step" stays local to a step. */
export function workflowSteps(yaml: string): string[] {
  return stripRefFilters(yaml)
    .split(/^\s*-\s+(?=(?:name|uses|run|id)\s*:)/m)
    .filter((step) => step.trim() !== '')
}

const globCharacters = /[*?[{]/

/** A glob is live when the directory before its first wildcard exists. */
function exists(root: string, path: string): boolean {
  const wildcard = path.search(globCharacters)
  const literal = wildcard < 0 ? path : path.slice(0, path.lastIndexOf('/', wildcard) + 1)
  return existsSync(join(root, ...literal.split('/').filter(Boolean)))
}

function listFiles(directory: string, filter: (name: string) => boolean): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => filter(name) && statSync(join(directory, name)).isFile())
    .sort()
    .map((name) => join(directory, name))
}

/** Collect every checked reference with the file (and script) it came from. */
function collectReferences(root: string): Reference[] {
  const references: Reference[] = []
  const add = (source: string, texts: readonly string[]) => {
    for (const text of texts)
      for (const path of extractReferences(text)) references.push({ source, path })
  }

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  for (const [name, script] of Object.entries(manifest.scripts ?? {}))
    add(`package.json#scripts.${name}`, [script])

  const workflows = listFiles(resolve(root, '.github/workflows'), (name) => /\.ya?ml$/.test(name))
  for (const file of workflows)
    add(portable(relative(root, file)), workflowSteps(readFileSync(file, 'utf8')))

  for (const file of listFiles(resolve(root, '.githooks'), () => true))
    add(portable(relative(root, file)), [readFileSync(file, 'utf8')])

  return references
}

/** Every reference whose target is missing, formatted `source: path`. */
export function findDeadReferences(root: string): string[] {
  return collectReferences(root)
    .filter((reference) => !exists(root, reference.path))
    .map((reference) => `${reference.source}: ${reference.path}`)
}

if (import.meta.main) {
  const dead = findDeadReferences(process.cwd())
  for (const line of dead) console.error(`dead reference: ${line}`)
  if (dead.length) process.exit(1)
}
