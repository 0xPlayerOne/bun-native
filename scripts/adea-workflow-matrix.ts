/**
 * The M11 (#53) workflow matrix probe.
 *
 * It re-derives the wrapper-side state of every workflow row from this
 * repository's own sources and prints it, so the matrix's wrapper claims are
 * reproducible without a native app, a CEF install, a network call, an
 * account, or any private Adea data.
 *
 * The printed table is the authority for the wrapper-side state; the matrix
 * document cites this script as the reproducer.
 */
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';

export const WORKFLOWS = [
  {area: 'Application UI', term: 'session', expect: 'present'},
  {area: 'Terminals', term: 'terminal', expect: 'absent'},
  {area: 'Browser control', term: 'devtools', expect: 'absent'},
  {area: 'Previews', term: 'preview', expect: 'absent'},
  {area: 'Sessions and authentication', term: 'cookie', expect: 'present'},
  {area: 'File workflows', term: 'dialog', expect: 'absent'},
  {area: 'Diagnostics', term: 'cache', expect: 'present'},
  {area: 'Offline behavior', term: 'offline', expect: 'present'},
  {area: 'Input', term: 'clipboard', expect: 'absent'},
  {area: 'Accessibility', term: 'aria', expect: 'present'},
] as const;

export const CLASSES = [
  'wrapper gap',
  'application dependency on Chromium behavior',
  'engine/public-API limitation',
] as const;

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) found.push(path);
    }
  };
  walk(join(root, 'packages'));
  return found;
}

/** The wrapper-side state of one workflow, derived from the sources. */
export function deriveWorkflowState(
  root: string,
  term: string,
): {state: 'present' | 'absent'; files: string[]} {
  const needle = term.toLowerCase();
  const files = sourceFiles(root)
    .filter((file) => readFileSync(file, 'utf8').toLowerCase().includes(needle))
    .map((file) => relative(root, file));
  return {state: files.length > 0 ? 'present' : 'absent', files};
}

/** Every workflow's derived state, in the matrix's order. */
export function deriveMatrix(root: string) {
  return WORKFLOWS.map((row) => ({
    ...row,
    ...deriveWorkflowState(root, row.term),
  }));
}

/** The rows of the matrix document, parsed from its table. */
export function readMatrixRows(root: string): string[][] {
  const document = readFileSync(join(root, 'docs', 'm11-adea-workflow-matrix.md'), 'utf8');
  const rows: string[][] = [];
  for (const line of document.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 9) continue;
    if (cells[0] === 'Workflow' || cells[0] === 'Class' || cells[0] === '---') continue;
    if (cells[0].startsWith('---')) continue;
    rows.push(cells);
  }
  return rows;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const derived = deriveMatrix(root);
  const width = Math.max(...derived.map((row) => row.area.length));
  for (const row of derived) {
    console.log(
      `${row.area.padEnd(width)}  term=${row.term.padEnd(10)} derived=${row.state.padEnd(8)} files=${
        row.files.length > 0 ? row.files.slice(0, 2).join(', ') : '-'
      }`,
    );
  }
}
