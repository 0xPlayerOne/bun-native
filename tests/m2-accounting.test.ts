import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BYTE_CATEGORIES, DownloadAccounting, directoryBytes, fileBytes, unavailableBytes, validateByteMatrix, validateByteObservation } from '../benchmarks/lib/accounting.ts';
test('unknown download and update bytes remain null, never zero', () => {
  for (const category of BYTE_CATEGORIES) expect(unavailableBytes(category, 'Not collected').bytes).toBeNull();
  expect(() => validateByteObservation({ ...unavailableBytes('cache', 'Missing'), bytes: 0 })).toThrow('Unavailable');
});
test('byte categories cannot be silently omitted or duplicated', () => {
  const rows = BYTE_CATEGORIES.map(category => unavailableBytes(category, 'Not collected'));
  expect(validateByteMatrix(rows)).toHaveLength(5);
  expect(() => validateByteMatrix(rows.slice(1))).toThrow('Incomplete');
  rows[0] = rows[1]!; expect(() => validateByteMatrix(rows)).toThrow('Duplicate');
});
test('records received download body bytes and digest, not content-length estimates', () => {
  const download = new DownloadAccounting(6); download.receive(new TextEncoder().encode('abc')); download.receive(new TextEncoder().encode('def'));
  expect(download.finish('Trusted fixture response')).toMatchObject({ bytes: 6, sha256: createHash('sha256').update('abcdef').digest('hex'), accounting: 'received-body' });
  expect(() => download.receive(new Uint8Array())).toThrow(); expect(() => download.finish('again')).toThrow();
});
test('enforces download budgets including empty bodies', () => {
  const empty = new DownloadAccounting(0); expect(empty.finish('HTTP response completed without body').bytes).toBe(0);
  const small = new DownloadAccounting(1); expect(() => small.receive(new Uint8Array(2))).toThrow('budget');
  for (const max of [-1, NaN, Infinity, 1.5]) expect(() => new DownloadAccounting(max)).toThrow();
});
test('installer and received-download accounting cannot be interchanged', () => {
  const row = new DownloadAccounting(0).finish('No body');
  expect(() => validateByteObservation({ ...row, category: 'installer' })).toThrow('Installer');
  expect(() => validateByteObservation({ ...row, accounting: 'file-content' })).toThrow('Downloads');
});
test('installed and installer bytes are independently measured and duplicated payload remains visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-m2-bytes-'));
  try {
    await mkdir(join(root, 'installed')); await writeFile(join(root, 'installed/one'), 'payload'); await writeFile(join(root, 'installed/two'), 'payload');
    await writeFile(join(root, 'installer.zip'), 'compressed-fixture');
    const installed = await directoryBytes('installed', join(root, 'installed'), 'Synthetic directory fixture');
    const installer = await fileBytes('installer', join(root, 'installer.zip'), 'Synthetic installer fixture');
    expect(installed.bytes).toBe(14); expect(installer.bytes).toBe(18);
    expect(installed.accounting).toBe('logical-directory'); expect(installer.accounting).toBe('file-content');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('file measurement rejects directories and missing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-m2-bytes-'));
  try { await expect(fileBytes('installer', root, 'bad')).rejects.toThrow(); await expect(fileBytes('installer', join(root, 'absent'), 'bad')).rejects.toThrow(); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test.skipIf(process.platform === 'win32')('symbolic installer paths are not followed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-m2-link-'));
  try { await writeFile(join(root, 'actual'), 'data'); await symlink('actual', join(root, 'link')); await expect(fileBytes('installer', join(root, 'link'), 'bad')).rejects.toThrow('ordinary'); }
  finally { await rm(root, { recursive: true, force: true }); }
});
