import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectRun, inspectJobs } from '../../scripts/quality/release-qualification.mjs';

const sha = 'a'.repeat(40);
const repo = '0xPlayerOne/bun-native';
const validation = { name: 'Bun Native Validation', path: '.github/workflows/bun-native.yml' };
const codeql = { name: 'CodeQL', path: '.github/workflows/codeql.yml' };
const run = (entry) => ({ ...entry, id: 1, head_sha: sha, head_branch: 'main',
  event: 'push', repository: { full_name: repo }, run_attempt: 1,
  status: 'completed', conclusion: 'success' });
const job = (name, step) => ({ name, status: 'completed', conclusion: 'success',
  steps: step ? [{ name: step, conclusion: 'success' }] : [] });
const analyses = [
  job('CodeQL / Analyze (Actions)', 'Analyze'),
  job('CodeQL / Analyze (TypeScript)', 'Analyze'),
  job('CodeQL / Analyze (Python)', 'Analyze'),
  job('CodeQL / Analyze (Rust)', 'Analyze Rust'),
];
for (const workflow of [validation, codeql]) {
  test(workflow.name + ': only an original, complete, exact-main push qualifies', () => {
    const source = run(workflow);
    assert.equal(inspectRun([source], workflow, sha, repo).kind, 'success');
    assert.equal(inspectRun([source], workflow, 'b'.repeat(40), repo).kind, 'pending');
    assert.equal(inspectRun([{ ...source, event: 'pull_request' }], workflow, sha, repo).kind, 'pending');
    assert.equal(inspectRun([{ ...source, run_attempt: 2 }], workflow, sha, repo).kind, 'fail');
    assert.equal(inspectRun([{ ...source, conclusion: 'cancelled' }], workflow, sha, repo).kind, 'fail');
    assert.equal(inspectRun([{ ...source, conclusion: null, status: 'in_progress' }], workflow, sha, repo).kind, 'pending');
    assert.equal(inspectRun([source, source], workflow, sha, repo).kind, 'fail');
  });
}
test('Validation must complete and retain its real Gate', () => {
  const jobs = [job('Source quality'), job('Validation / Gate')];
  assert.equal(inspectJobs(jobs, validation.name).kind, 'success');
  assert.equal(inspectJobs([job('Source quality')], validation.name).kind, 'fail');
  assert.equal(inspectJobs([...jobs, { ...job('Native Linux'), conclusion: 'skipped' }], validation.name).kind, 'fail');
});
test('every language must actually analyze, not execute Not applicable', () => {
  assert.equal(inspectJobs(analyses, codeql.name).kind, 'success');
  for (let i = 0; i < analyses.length; i++) {
    assert.equal(inspectJobs(analyses.filter((_, index) => index !== i), codeql.name).kind, 'fail');
    const skippedStep = analyses.map((entry, index) => index === i
      ? { ...entry, steps: [ { name: 'Not applicable', conclusion: 'success' } ] }
      : entry);
    assert.equal(inspectJobs(skippedStep, codeql.name).kind, 'fail');
  }
  assert.equal(inspectJobs([...analyses, { ...job('CodeQL / Detect'), conclusion: 'failure' }], codeql.name).kind, 'fail');
});
