import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  checkDocLinks,
  githubSlug,
  headingAnchors,
  relativeLinks,
  trackedFiles,
} from '../../scripts/quality/doc-links.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'bun-native-doc-links-'))
  temporary.push(root)
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, name)
    await mkdir(dirname(file), { recursive: true })
    await Bun.write(file, source)
  }
  return { root, tracked: Object.keys(files) }
}

describe('GitHub heading slugs', () => {
  test.each([
    ['Getting Started', 'getting-started'],
    ['7. Agent PR checklist', '7-agent-pr-checklist'],
    [
      'Hosted paint, OS input, and assigned-device evidence',
      'hosted-paint-os-input-and-assigned-device-evidence',
    ],
    ['`bun run check` (local gate)', 'bun-run-check-local-gate'],
    ['Use **bold** and _emphasis_', 'use-bold-and-emphasis'],
    ['snake_case_name stays', 'snake_case_name-stays'],
    ['[Linked](./x.md) heading', 'linked-heading'],
    ['A / B — C', 'a--b--c'],
    ['Ünïcödé Headings', 'ünïcödé-headings'],
  ])('%s -> %s', (heading, slug) => {
    expect(githubSlug(heading)).toBe(slug)
  })
})

describe('markdown parsing', () => {
  test('collects ATX, setext, duplicate and HTML anchors but not fenced code', () => {
    const anchors = headingAnchors(
      [
        '# Title #',
        '## Repeat',
        '## Repeat',
        'Setext heading',
        '--------------',
        '<a id="custom-anchor"></a>',
        '```md',
        '# Not a heading',
        '```',
        '- list item',
        '---',
      ].join('\n')
    )
    expect([...anchors].sort()).toEqual([
      'custom-anchor',
      'repeat',
      'repeat-1',
      'setext-heading',
      'title',
    ])
  })

  test('extracts relative inline, image and reference links with line numbers', () => {
    const links = relativeLinks(
      [
        'See [guide](docs/guide.md#setup "Title") and ![logo](<img/a b.png>).',
        'External [site](https://example.com), [mail](mailto:a@b.c) and [proto](//cdn.example).',
        'Inline code `[skip](missing.md)` is ignored, [same page](#local) is kept.',
        '~~~',
        '[fenced](missing.md)',
        '~~~',
        '[ref]: ../other.md',
      ].join('\n')
    )
    expect(links).toEqual([
      { target: 'docs/guide.md#setup', line: 1 },
      { target: 'img/a b.png', line: 1 },
      { target: '#local', line: 3 },
      { target: '../other.md', line: 7 },
    ])
  })
})

describe('relative markdown link check', () => {
  test('reports missing files, missing anchors and links outside the repository', async () => {
    const { root, tracked } = await fixture({
      'README.md': [
        '# Readme',
        '[ok](docs/guide.md#set-up) [dir](docs) [self](#readme) [code](src/a.ts#L3)',
        '[gone](docs/missing.md) [bad anchor](docs/guide.md#nope) [escape](../outside.md)',
        '[local bad](#nowhere)',
      ].join('\n'),
      'docs/guide.md': '## Set up\n[back](../README.md#readme) [root](/src/a.ts)',
      'src/a.ts': 'export {}',
    })
    expect(await checkDocLinks(root, tracked)).toEqual([
      'README.md:3: missing link target docs/missing.md',
      'README.md:3: missing heading anchor docs/guide.md#nope',
      'README.md:3: missing link target ../outside.md',
      'README.md:4: missing heading anchor #nowhere',
    ])
  })

  test('reports malformed percent escapes in anchors without aborting other checks', async () => {
    const { root, tracked } = await fixture({
      'README.md': [
        '# Home',
        '[encoded valid](docs/guide.md#valid%2Danchor)',
        '[bad local](#bad%ZZ)',
        '[bad target](docs/guide.md#%E0%A4%A)',
        '[missing](docs/missing.md)',
      ].join('\\n'),
      'docs/guide.md': '## Valid anchor',
    })
    expect(await checkDocLinks(root, tracked)).toEqual([
      'README.md:3: malformed link #bad%ZZ',
      'README.md:4: malformed link docs/guide.md#%E0%A4%A',
      'README.md:5: missing link target docs/missing.md',
    ])
  })

  test('treats untracked files as missing so local-only files cannot satisfy a link', async () => {
    const { root } = await fixture({
      'README.md': '[draft](notes.md)',
      'notes.md': '# Draft',
    })
    expect(await checkDocLinks(root, ['README.md'])).toEqual([
      'README.md:1: missing link target notes.md',
    ])
  })

  test('every tracked markdown file has resolvable relative links and anchors', async () => {
    const root = resolve(import.meta.dir, '../..')
    expect(await checkDocLinks(root, trackedFiles(root))).toEqual([])
  })
})
