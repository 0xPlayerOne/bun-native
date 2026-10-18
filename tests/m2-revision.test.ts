import { expect, test } from 'bun:test';
import { assertEditApplied, assertFailedEdit, revisionObservation, type RevisionObservation } from '../benchmarks/lib/revision.ts';
const initial: RevisionObservation = { revision: 'initial', document: 'document-1', instance: 'instance-1', generation: 1, sequence: 1, retainedInput: 'keep', counter: 3 };
const changed = (overrides: Partial<RevisionObservation> = {}) => ({ ...initial, revision: 'edited', generation: 2, sequence: 2, ...overrides });
test('revision observations are snapshots, not mutable aliases', () => { const value = { ...initial }; const parsed = revisionObservation(value); value.counter = 8; expect(parsed.counter).toBe(3); expect(Object.isFrozen(parsed)).toBe(true); });
test('frontend HMR requires a new revision in the same document and service', () => { expect(() => assertEditApplied(initial, changed(), 'edited', 'frontend-hmr')).not.toThrow(); });
test('full page reload cannot masquerade as HMR', () => { expect(() => assertEditApplied(initial, changed({ document: 'document-2' }), 'edited', 'frontend-hmr')).toThrow('replaced'); });
test('backend replacement cannot masquerade as frontend HMR', () => { expect(() => assertEditApplied(initial, changed({ instance: 'instance-2' }), 'edited', 'frontend-hmr')).toThrow('replaced'); });
test('stale acknowledgements are rejected even when the label matches', () => { expect(() => assertEditApplied(initial, changed({ sequence: 1 }), 'edited', 'frontend-hmr')).toThrow('Stale'); });
test('a changed UI label alone does not prove module replacement', () => { expect(() => assertEditApplied(initial, changed({ generation: 1 }), 'edited', 'frontend-hmr')).toThrow('module'); });
test('unchanged revisions and wrong revisions fail', () => {
  expect(() => assertEditApplied(initial, initial, 'initial', 'frontend-hmr')).toThrow('revision');
  expect(() => assertEditApplied(initial, changed(), 'another', 'frontend-hmr')).toThrow('revision');
});
test('state loss during an otherwise correct edit fails', () => {
  for (const change of [{ counter: 0 }, { retainedInput: '' }]) expect(() => assertEditApplied(initial, changed(change), 'edited', 'frontend-hmr')).toThrow('state');
});
test('desktop relaunch requires a genuinely new backend instance', () => {
  expect(() => assertEditApplied(initial, changed(), 'edited', 'backend-relaunch')).toThrow('relaunch');
  expect(() => assertEditApplied(initial, changed({ instance: 'new' }), 'edited', 'backend-relaunch')).not.toThrow();
});
test('managed replacement separately requires the old document to survive', () => {
  expect(() => assertEditApplied(initial, changed({ instance: 'new' }), 'edited', 'backend-preserving')).not.toThrow();
  expect(() => assertEditApplied(initial, changed({ instance: 'new', document: 'new-doc' }), 'edited', 'backend-preserving')).toThrow('identity');
});
test('failed edits require a fresh diagnostic and last usable state', () => {
  const current = { ...initial, sequence: 2 };
  const diagnostic = { kind: 'compile-error', sequence: 2, attemptedRevision: 'broken' };
  expect(() => assertFailedEdit(initial, current, diagnostic)).not.toThrow();
  expect(() => assertFailedEdit(initial, current, { ...diagnostic, sequence: 1 })).toThrow('Stale');
  expect(() => assertFailedEdit(initial, { ...current, revision: 'broken' }, diagnostic)).toThrow('usable');
});
test('unbounded, extra and malformed observation data are rejected', () => {
  for (const value of [null, [], { ...initial, nativeToken: 'secret' }, { ...initial, generation: 0 }, { ...initial, sequence: NaN },
    { ...initial, counter: 1.2 }, { ...initial, revision: 'x'.repeat(257) }, { ...initial, retainedInput: 'x'.repeat(4097) }]) expect(() => revisionObservation(value)).toThrow();
});
