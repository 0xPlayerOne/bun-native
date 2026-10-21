import {it} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {CLASSES, WORKFLOWS, deriveMatrix, readMatrixRows} from '../scripts/adea-workflow-matrix.ts';

const root = resolve(import.meta.dirname, '..');

it('derives every workflow row from the wrapper sources', () => {
  const derived = deriveMatrix(root);
  assert.equal(derived.length, WORKFLOWS.length);
  for (const row of derived) {
    assert.ok(row.state === 'present' || row.state === 'absent', row.area);
    if (row.state === 'present') assert.ok(row.files.length > 0, row.area);
  }
});

it('states the workflow matrix with a class and evidence for every row', () => {
  const rows = readMatrixRows(root);
  assert.equal(rows.length, WORKFLOWS.length);
  const areas = rows.map((row) => row[0]);
  for (const workflow of WORKFLOWS) assert.ok(areas.includes(workflow.area), workflow.area);
  for (const row of rows) {
    assert.ok((CLASSES as readonly string[]).includes(row[3]), `${row[0]} class ${row[3]}`);
    assert.ok(
      row[4].includes('fixture:') || row[4].toLowerCase().includes('gap'),
      `${row[0]} evidence ${row[4]}`,
    );
    assert.ok(row[5].length > 0, `${row[0]} platform`);
    assert.ok(row[6].length > 0, `${row[0]} impact`);
    assert.ok(row[7].length > 0, `${row[0]} candidate fix`);
  }
});

it('cites only repository paths that exist', () => {
  const document = readFileSync(join(root, 'docs', 'm11-adea-workflow-matrix.md'), 'utf8');
  const cited = [...document.matchAll(/`((?:packages|scripts|tests|docs)\/[^`]+)`/g)].map((m) => m[1]);
  assert.ok(cited.length > 0);
  for (const path of cited) {
    if (path.includes('#')) continue;
    if (path.includes('*')) continue; // a source glob, not a path
    assert.ok(existsSync(join(root, path)), path);
  }
});

it('keeps the rendering capability claim explicit and untested', () => {
  const document = readFileSync(join(root, 'docs', 'm11-adea-workflow-matrix.md'), 'utf8');
  assert.ok(document.includes('WebGL'));
  assert.ok(document.includes('not tested'));
  assert.ok(document.includes('engine/public-API limitation'));
});
