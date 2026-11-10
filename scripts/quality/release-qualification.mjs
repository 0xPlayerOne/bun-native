// Fail-closed main-SHA release preflight; PR-head checks are insufficient.
// This module does not publish, retry CI, or modify any workflow deadline.
const definitions = [
  { name: 'Bun Native Validation', path: '.github/workflows/bun-native.yml' },
  { name: 'CodeQL', path: '.github/workflows/codeql.yml' },
];
const analyzers = [['Actions', 'Analyze'], ['TypeScript', 'Analyze'], ['Python', 'Analyze'], ['Rust', 'Analyze Rust']];

export function inspectRun(runs, expected, sha, repository) {
  if (!Array.isArray(runs) || !/^[a-f0-9]{40}$/.test(sha)) return { kind: 'fail', why: 'Malformed input' };
  const matches = runs.filter((r) => r?.name === expected.name && r.path === expected.path &&
    r.head_sha === sha && r.head_branch === 'main' && r.event === 'push' &&
    r.repository?.full_name === repository);
  if (!matches.length) return { kind: 'pending', why: expected.name + ': missing exact push run' };
  if (matches.length !== 1) return { kind: 'fail', why: expected.name + ': ambiguous run ownership' };
  const r = matches[0];
  if (!Number.isSafeInteger(r.id) || r.id <= 0 || r.run_attempt !== 1) {
    return { kind: 'fail', why: expected.name + ': invalid run or rerun attempt' };
  }
  if (r.status !== 'completed') {
    if (r.conclusion === null && ['queued', 'pending', 'in_progress', 'waiting', 'requested'].includes(r.status)) {
      return { kind: 'pending', why: expected.name + ': ' + r.status };
    }
    return { kind: 'fail', why: expected.name + ': malformed run state' };
  }
  return r.conclusion === 'success'
    ? { kind: 'success', id: r.id }
    : { kind: 'fail', why: expected.name + ': ' + String(r.conclusion) };
}

export function inspectJobs(jobs, name) {
  if (!Array.isArray(jobs) || !jobs.length ||
      jobs.some((j) => !j || j.status !== 'completed' || j.conclusion !== 'success')) {
    return { kind: 'fail', why: name + ': unfinished, skipped, missing or failed jobs' };
  }
  const only = (target) => jobs.filter((j) => j.name === target);
  if (name === 'Bun Native Validation') {
    if (only('Validation / Gate').length !== 1) return { kind: 'fail', why: 'Missing real Validation / Gate' };
  } else if (name === 'CodeQL') {
    for (const [language, step] of analyzers) {
      const job = 'CodeQL / Analyze (' + language + ')';
      const rows = only(job);
      if (rows.length !== 1 || !Array.isArray(rows[0].steps) ||
          rows[0].steps.filter((s) => s.name === step && s.conclusion === 'success').length !== 1) {
        return { kind: 'fail', why: job + ': no successful real ' + step + ' step' };
      }
    }
  } else return { kind: 'fail', why: 'Unknown workflow' };
  return { kind: 'success' };
}

async function run() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const token = process.env.GH_TOKEN;
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') ||
      !/^[a-f0-9]{40}$/.test(sha || '') || !token) throw Error('Missing release input or API token');
  const read = async (path) => {
    const response = await fetch(api + '/repos/' + repo + '/' + path, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw Error('GitHub API ' + path.split('?')[0] + ': HTTP ' + response.status);
    return response.json();
  };
  const assertMain = async () => {
    const ref = await read('git/ref/heads/main');
    if (ref?.object?.sha !== sha) throw Error('Protected main moved from exact release input ' + sha);
  };
  const deadline = Date.now() + 40 * 60_000;
  while (Date.now() < deadline) {
    await assertMain();
    const listing = await read('actions/runs?branch=main&event=push&head_sha=' + sha + '&per_page=100');
    if (!Array.isArray(listing?.workflow_runs) || !Number.isSafeInteger(listing.total_count) ||
        listing.total_count > 100) throw Error('Malformed or truncated run listing');
    const states = definitions.map((entry) => inspectRun(listing.workflow_runs, entry, sha, repo));
    const failed = states.find((s) => s.kind === 'fail');
    if (failed) throw Error(failed.why);
    const pending = states.find((s) => s.kind === 'pending');
    if (pending) {
      console.log(pending.why);
      await new Promise((resolve) => setTimeout(resolve, 20000));
      continue;
    }
    for (let i = 0; i < definitions.length; i++) {
      const jobs = [];
      for (let page = 1; page <= 10; page++) {
        const result = await read('actions/runs/' + states[i].id + '/attempts/1/jobs?per_page=100&page=' + page);
        if (!Array.isArray(result?.jobs)) throw Error('Invalid job list for ' + definitions[i].name);
        jobs.push(...result.jobs);
        if (result.jobs.length < 100) break;
        if (page === 10) throw Error('Job pagination overflow');
      }
      const verdict = inspectJobs(jobs, definitions[i].name);
      if (verdict.kind !== 'success') throw Error(verdict.why);
    }
    await assertMain();
    console.log('Verified exact protected-main Validation/Gate and all four real CodeQL analyzes: ' + sha);
    return;
  }
  throw Error('Timeout awaiting successful exact-main CI; refusing stable release');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  run().catch((error) => { console.error('::error::' + error.message); process.exitCode = 1; });
}
