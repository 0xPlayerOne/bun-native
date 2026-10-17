/** Run upstream Code Foundry, then apply Bunly's small, deterministic layout overlay. */
import { access, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const BILLING_GUARD = "vars.CI_BILLING_PAUSED != 'true'";
const OWNED_WORKFLOWS = [
  'benchmarks.yml', 'cef-runtime.yml', 'cef-typecheck.yml', 'ci.yml',
  'development.yml', 'electrobun.yml', 'kernel-counters.yml', 'qualification.yml',
] as const;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected YAML mapping');
  return value as Record<string, unknown>;
}

/** Preserve authored jobs and their original conditions; never replace their steps. */
export function guardWorkflow(source: string): string {
  const jobs = record(record(Bun.YAML.parse(source))['jobs']);
  let result = source;
  for (const [name, raw] of Object.entries(jobs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error('Unsupported job name');
    const job = record(raw);
    const condition = job['if'];
    if (typeof condition === 'string' && condition.includes(BILLING_GUARD)) continue;
    if (condition !== undefined) throw new Error(`Review the existing condition for job ${name} before adding its billing guard`);
    const heading = `  ${name}:\n`;
    if (result.split(heading).length !== 2) throw new Error(`Cannot locate unambiguous job ${name}`);
    result = result.replace(heading, `${heading}    if: ${BILLING_GUARD}\n`);
  }
  return result;
}

/** Upstream templates use root directories; these native/benchmark manifests are nested. */
export function dependabotDirectories(source: string): string {
  const parsed = record(Bun.YAML.parse(source));
  if (!Array.isArray(parsed['updates'])) throw new Error('Dependabot updates are missing');
  let result = source;
  const directories: Readonly<Record<string, readonly string[]>> = {
    bun: ['/', '/benchmarks/adapters/electron', '/benchmarks/adapters/electrobun', '/benchmarks/fixtures'],
    cargo: ['/native', '/native/cef-host'],
  };
  for (const entry of parsed['updates']) {
    const update = record(entry);
    const ecosystem = String(update['package-ecosystem']);
    const paths = directories[ecosystem];
    if (!paths) continue;
    const blocks = result.split(/(?=^  - package-ecosystem:)/m);
    let replacements = 0;
    result = blocks.map(block => {
      if (!block.startsWith(`  - package-ecosystem: ${ecosystem}\n`)) return block;
      replacements++;
      if (!/^    directory: \/$/m.test(block)) throw new Error(`Unexpected upstream ${ecosystem} layout`);
      return block.replace(/^    directory: \/$/m, `    directories:\n${paths.map(path => `      - ${path}`).join('\n')}`);
    }).join('');
    if (replacements !== 1) throw new Error(`Expected exactly one ${ecosystem} updater`);
  }
  return result;
}

export async function verifyGithubLayout(root: string): Promise<void> {
  const entries = await readdir(root);
  for (const misplaced of ['.guthub', 'workflows', 'ISSUE_TEMPLATE', 'CODEOWNERS']) {
    if (entries.includes(misplaced)) throw new Error(`Misplaced GitHub content: ${misplaced}`);
  }
  const github = await readdir(resolve(root, '.github'));
  if (github.includes('.github')) throw new Error('Nested .github/.github is not supported');
  if (new Set(github.map(name => name.toLowerCase())).size !== github.length) throw new Error('Case-colliding .github paths');
  for (const file of ['code-foundry.yml', 'CODEOWNERS', 'PULL_REQUEST_TEMPLATE.md', 'workflows/validation.yml']) {
    await access(resolve(root, '.github', file));
  }
}

export async function syncFoundry(root: string, mode: 'init' | 'sync' = 'sync'): Promise<void> {
  const cli = resolve(root, 'node_modules/code-foundry/src/cli.mjs');
  await access(cli);
  const child = Bun.spawn([process.execPath, cli, mode, '--target', root], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error('Code Foundry synchronization failed');
  const dependabot = resolve(root, '.github/dependabot.yml');
  await writeFile(dependabot, dependabotDirectories(await readFile(dependabot, 'utf8')));
  for (const name of OWNED_WORKFLOWS) {
    const file = resolve(root, '.github/workflows', name);
    const before = await readFile(file, 'utf8');
    const after = guardWorkflow(before);
    if (before !== after) await writeFile(file, after);
  }
  // Bunly already requires Bun. Do not add a global Node installation just to run its hook.
  const hook = resolve(root, '.githooks/pre-commit');
  const upstream = await readFile(hook, 'utf8');
  const invocation = 'exec node_modules/.bin/code-foundry pre-commit';
  if (!upstream.includes(invocation)) throw new Error('Unexpected upstream hook; inspect before adapting it');
  await writeFile(hook, upstream.replace(invocation, 'exec bun --bun code-foundry pre-commit'));
  await chmod(hook, 0o755);
  await verifyGithubLayout(root);
  console.log('Bunly overlay verified: .github layout, nested dependency manifests, billing guards, and Bun hook.');
}

if (import.meta.main) {
  const mode = process.argv[2] ?? 'sync';
  if (!['init', 'sync'].includes(mode) || process.argv.length > 3) throw new Error('Use bun scripts/sync-foundry.ts [init|sync]');
  await syncFoundry(resolve(import.meta.dir, '..'), mode as 'init' | 'sync');
}
