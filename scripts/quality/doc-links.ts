import { dirname, posix, resolve } from 'node:path'

/** One relative link found in a markdown document, with its 1-based source line. */
export type MarkdownLink = { target: string; line: number }

const fence = /^ {0,3}(`{3,}|~{3,})/

/**
 * Split markdown into prose lines with fenced code blocks blanked out, keeping line numbers.
 * Indented code blocks are rare in this repository and are not treated specially.
 */
function proseLines(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/)
  let open: string | undefined
  return lines.map((line) => {
    const marker = fence.exec(line)?.[1]
    if (open) {
      if (
        marker &&
        marker[0] === open[0] &&
        marker.length >= open.length &&
        !line.trim().slice(marker.length)
      )
        open = undefined
      return ''
    }
    if (marker) {
      open = marker
      return ''
    }
    return line
  })
}

/** Remove inline code spans so links and anchors written as code are ignored. */
function stripInlineCode(line: string): string {
  return line.replace(/(`+)[^`]*?\1/g, (span) => ' '.repeat(span.length))
}

/** Inline HTML tags render no text; repeat until stable so nested fragments like `<<b>x>` cannot leave a tag behind. */
function stripTags(text: string): string {
  let previous: string
  do {
    previous = text
    text = text.replace(/<[^<>]*>/g, '')
  } while (text !== previous)
  return text
}

/** GitHub's heading anchor slug: rendered text, lowercased, punctuation dropped, spaces to hyphens. */
export function githubSlug(heading: string): string {
  const text = stripTags(heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')) // links and images keep their text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*{1,3})(\S(?:.*?\S)?)\1/g, '$2') // emphasis markers render no text
    .replace(/(^|[^\p{L}\p{N}])(_{1,3})(\S(?:.*?\S)?)\2(?![\p{L}\p{N}])/gu, '$1$3')
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

/** Every anchor GitHub generates for a document, including -1/-2 suffixes for repeats. */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>()
  const counts = new Map<string, number>()
  const add = (heading: string) => {
    const slug = githubSlug(heading)
    const seen = counts.get(slug) ?? 0
    counts.set(slug, seen + 1)
    anchors.add(seen ? `${slug}-${seen}` : slug)
  }
  const lines = proseLines(markdown)
  lines.forEach((line, index) => {
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (atx) return add(atx[1] ?? '')
    const next = lines[index + 1]
    if (
      line.trim() &&
      next &&
      /^ {0,3}(=+|-+)[ \t]*$/.test(next) &&
      !/^ {0,3}([-*+]|\d+[.)])\s/.test(line)
    )
      add(line)
    // Explicit HTML anchors are also valid fragment targets.
    for (const match of line.matchAll(/<a\s[^>]*\b(?:name|id)=["']([^"']+)["']/gi))
      anchors.add(match[1]!)
  })
  return anchors
}

/** Inline and reference-definition link targets that are not external URLs. */
export function relativeLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = []
  const add = (raw: string, line: number) => {
    let target = raw.trim()
    if (target.startsWith('<'))
      target = target.slice(1, target.indexOf('>') === -1 ? undefined : target.indexOf('>'))
    else target = target.split(/\s+/)[0] ?? ''
    // Skip schemes (http:, https:, mailto:, ...) and protocol-relative URLs.
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return
    links.push({ target, line })
  }
  proseLines(markdown).forEach((source, index) => {
    const line = stripInlineCode(source)
    const definition = /^ {0,3}\[[^\]]+\]:\s*(\S+)/.exec(line)
    if (definition) return add(definition[1]!, index + 1)
    for (const match of line.matchAll(
      /!?\[(?:[^\]\\]|\\.)*\]\(((?:<[^<>\n]*>|(?:[^()\s]|\([^()]*\))+)(?:\s+"[^"]*")?)\)/g
    ))
      add(match[1]!, index + 1)
  })
  return links
}

/** Third-party trees whose docs link into generated rustdoc output, not this repository. */
const vendored = ['native/vendor/']

/** Check that every relative link in tracked markdown resolves to a tracked path and heading. */
export async function checkDocLinks(root: string, tracked: readonly string[]): Promise<string[]> {
  const files = new Set(tracked)
  const directories = new Set<string>()
  for (const file of tracked)
    for (
      let directory = posix.dirname(file);
      directory !== '.';
      directory = posix.dirname(directory)
    )
      directories.add(directory)
  const anchors = new Map<string, Set<string>>()
  const anchorsOf = async (file: string) => {
    let found = anchors.get(file)
    if (!found)
      anchors.set(file, (found = headingAnchors(await Bun.file(resolve(root, file)).text())))
    return found
  }

  const errors: string[] = []
  for (const file of tracked
    .filter((path) => path.endsWith('.md') && !vendored.some((prefix) => path.startsWith(prefix)))
    .sort()) {
    for (const { target, line } of relativeLinks(await Bun.file(resolve(root, file)).text())) {
      const hash = target.indexOf('#')
      const pathPart = hash === -1 ? target : target.slice(0, hash)
      const fragment = hash === -1 ? undefined : target.slice(hash + 1)
      let decoded: string
      try {
        decoded = decodeURIComponent(pathPart.split('?')[0]!)
      } catch {
        errors.push(`${file}:${line}: malformed link ${target}`)
        continue
      }
      const resolved = !decoded
        ? file
        : decoded.startsWith('/')
          ? posix.normalize(decoded.slice(1)).replace(/\/$/, '')
          : posix.join(posix.dirname(file), decoded).replace(/\/$/, '')
      if (resolved.startsWith('..') || (!files.has(resolved) && !directories.has(resolved))) {
        errors.push(`${file}:${line}: missing link target ${target}`)
        continue
      }
      if (fragment && resolved.endsWith('.md') && files.has(resolved)) {
        if (!(await anchorsOf(resolved)).has(decodeURIComponent(fragment)))
          errors.push(`${file}:${line}: missing heading anchor ${target}`)
      }
    }
  }
  return errors
}

/** Git-tracked paths relative to the repository root. */
export function trackedFiles(root: string): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root })
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`)
  return result.stdout.toString().split('\0').filter(Boolean)
}

if (import.meta.main) {
  const root = resolve(dirname(import.meta.path), '../..')
  const errors = await checkDocLinks(root, trackedFiles(root))
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else console.log('Relative markdown links and heading anchors verified')
}
