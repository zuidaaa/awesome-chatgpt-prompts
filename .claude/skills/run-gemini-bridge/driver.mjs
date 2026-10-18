#!/usr/bin/env node
// Drives the Gemini bridge without a GitHub runner or an API key.
//
//   node .claude/skills/run-gemini-bridge/driver.mjs bot "<comment>" [options]
//   node .claude/skills/run-gemini-bridge/driver.mjs smoke
//
// "bot" runs scripts/gemini-bridge/bot.mjs the way .github/workflows/gemini_bot.yml does (COMMENT_BODY, OUT_DIR,
// GITHUB_OUTPUT), against a fake Gemini (fake-gemini.mjs) and inside a throwaway copy of the repo, because a
// "/gemini fix" writes its edits into the working directory.
//   --reply <text>                     what the fake Gemini answers
//   --edit <path> <search> <replace>   shortcut: answer with a one-edit fix proposal
//   --diff <file>                      use this file as the PR diff (needed for "/gemini review")
//   --fail <503,500,...>               HTTP statuses the fake returns before succeeding (retry path; real 1/3/5 s waits)
//   --keep                             keep the scratch copy and print its path
// "smoke" runs the unit tests, then a fixed set of commands, and checks model choice and context files.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SKILL_DIR, '../../..');
const FAKE = join(SKILL_DIR, 'fake-gemini.mjs');
const COPY = ['README.md', 'prompts.csv', 'CONTRIBUTING.md', 'scripts'];
const ALLOWED = ['README.md', 'prompts.csv', 'CONTRIBUTING.md'];

function runBot(comment, { reply, diff, fail, keep = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'gemini-bridge-'));
  const repo = join(work, 'repo');
  const out = join(work, 'out');
  for (const entry of COPY) cpSync(join(ROOT, entry), join(repo, entry), { recursive: true });
  mkdirSync(out);
  if (diff) cpSync(diff, join(out, 'pr.diff'));

  const log = join(work, 'requests.jsonl');
  const ghOutput = join(work, 'github-output');
  writeFileSync(ghOutput, '');
  const env = {
    ...process.env,
    COMMENT_BODY: comment,
    OUT_DIR: out,
    GITHUB_OUTPUT: ghOutput,
    GEMINI_API_KEY: 'fake-key',
    FAKE_LOG: log,
    ...(reply !== undefined && { FAKE_REPLY: reply }),
    ...(fail && { FAKE_FAIL: fail }),
  };
  const started = Date.now();
  const proc = spawnSync('node', ['--import', FAKE, 'scripts/gemini-bridge/bot.mjs'], { cwd: repo, env, encoding: 'utf8' });

  const requests = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const changed = ALLOWED.filter((p) => readFileSync(join(repo, p), 'utf8') !== readFileSync(join(ROOT, p), 'utf8'));
  const result = {
    exitCode: proc.status,
    seconds: ((Date.now() - started) / 1000).toFixed(1),
    stderr: proc.stderr.trim(),
    requests,
    reply: existsSync(join(out, 'reply.md')) ? readFileSync(join(out, 'reply.md'), 'utf8') : null,
    githubOutput: readFileSync(ghOutput, 'utf8').trim(),
    changed,
    // Word diff: README lines are often longer than a terminal, so a line diff would hide the changed word.
    diffs: changed.map((p) => spawnSync('git', ['diff', '--no-index', '--word-diff=porcelain', join(ROOT, p), join(repo, p)], { encoding: 'utf8' }).stdout),
  };
  if (keep) result.scratch = work;
  else rmSync(work, { recursive: true, force: true });
  return result;
}

function printResult(r) {
  console.log(`exit ${r.exitCode} in ${r.seconds}s`);
  for (const q of r.requests) {
    console.log(`request: HTTP ${q.status} model=${q.model} files=[${q.files.join(', ')}] promptChars=${q.promptChars} keyInUrl=${q.keyInUrl}`);
  }
  if (!r.requests.length) console.log('request: none (bot answered without calling Gemini)');
  console.log('--- reply.md');
  console.log(r.reply ?? '(missing)');
  console.log(`--- GITHUB_OUTPUT: ${r.githubOutput || '(empty)'}`);
  console.log(`--- changed files: ${r.changed.join(', ') || 'none'}`);
  for (const d of r.diffs) console.log(d.split('\n').filter((l) => /^[+-](?![+-]{2} )/.test(l)).join('\n'));
  if (r.stderr) console.log(`--- stderr\n${r.stderr}`);
  if (r.scratch) console.log(`--- scratch copy kept at ${r.scratch}`);
}

function parseBotArgs(args) {
  const [comment, ...rest] = args;
  if (!comment) throw new Error('usage: driver.mjs bot "<comment>" [--reply t] [--edit path search replace] [--diff f] [--fail 503] [--keep]');
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--reply') opts.reply = rest[++i];
    else if (flag === '--diff') opts.diff = resolve(rest[++i]);
    else if (flag === '--fail') opts.fail = rest[++i];
    else if (flag === '--keep') opts.keep = true;
    else if (flag === '--edit') {
      const [path, search, replace] = rest.slice(i + 1, i + 4);
      i += 3;
      opts.reply = JSON.stringify({ summary: 'Driver-Testedit', edits: [{ path, search, replace }] });
    } else throw new Error(`unknown option ${flag}`);
  }
  return { comment, opts };
}

function smoke() {
  const tests = spawnSync('node', ['--test', 'scripts/gemini-bridge/lib.test.mjs', 'scripts/gemini-bridge/bridge.test.mjs'], { cwd: ROOT, encoding: 'utf8' });
  const summary = tests.stdout.split('\n').filter((l) => /^# (pass|fail)/.test(l)).join(' ');
  console.log(`unit tests: ${summary}`);
  let failed = tests.status !== 0;

  const diffFile = join(mkdtempSync(join(tmpdir(), 'gemini-diff-')), 'pr.diff');
  writeFileSync(diffFile, 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n');
  const uniqueLine = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8').split('\n').find((l, _, all) => l.length > 20 && all.filter((x) => x === l).length === 1);

  const cases = [
    ['question -> lite', '/gemini Wofür ist das Repo?', {}, { model: 'gemini-3.5-flash-lite', files: ['CONTRIBUTING.md', 'README.md (Auszug)'] }],
    ['/gemini! -> argon', '/gemini! Sehr schwere Frage', {}, { model: 'gemini-4-argon' }],
    ['review without diff -> no call', '/gemini review Passt das?', {}, { requests: 0, replyHas: 'nur in Pull Requests' }],
    ['review small diff -> lite', '/gemini review Passt das?', { diff: diffFile }, { model: 'gemini-3.5-flash-lite', files: ['pr.diff'] }],
    ['fix README -> flash, README only', '/gemini fix Tippfehler in der README', { reply: '{"summary":"x","edits":[{"path":"README.md","search":"zz-nicht-da","replace":"y"}]}' }, { model: 'gemini-3.8-flash', files: ['README.md'], replyHas: 'Vorschlag verworfen' }],
    ['fix CONTRIBUTING applied -> lite', '/gemini fix Satz in CONTRIBUTING ändern', { reply: JSON.stringify({ summary: 'Satz geändert', edits: [{ path: 'CONTRIBUTING.md', search: uniqueLine, replace: `${uniqueLine} (Test)` }] }) }, { model: 'gemini-3.5-flash-lite', files: ['CONTRIBUTING.md'], changed: ['CONTRIBUTING.md'], output: 'applied=true' }],
    ['fix without file -> all three, flash', '/gemini fix Neuen Prompt hinzufügen', { reply: 'kein json' }, { model: 'gemini-3.8-flash', files: ['README.md', 'prompts.csv', 'CONTRIBUTING.md'] }],
    ['503 then success -> retried', '/gemini Kurz?', { fail: '503' }, { requests: 2 }],
    ['402 -> no retry', '/gemini Kurz?', { fail: '402' }, { requests: 1, replyHas: 'Gemini API 402' }],
  ];

  for (const [name, comment, opts, expect] of cases) {
    const r = runBot(comment, opts);
    const last = r.requests.at(-1);
    const problems = [];
    if (r.exitCode !== 0) problems.push(`exit ${r.exitCode}`);
    if (expect.model && last?.model !== expect.model) problems.push(`model ${last?.model}`);
    if (expect.files && JSON.stringify(last?.files) !== JSON.stringify(expect.files)) problems.push(`files ${JSON.stringify(last?.files)}`);
    if (expect.requests !== undefined && r.requests.length !== expect.requests) problems.push(`${r.requests.length} requests`);
    if (expect.replyHas && !r.reply?.includes(expect.replyHas)) problems.push('reply text');
    if (expect.changed && JSON.stringify(r.changed) !== JSON.stringify(expect.changed)) problems.push(`changed ${r.changed}`);
    if (expect.output && r.githubOutput !== expect.output) problems.push(`GITHUB_OUTPUT "${r.githubOutput}"`);
    if (r.requests.some((q) => q.keyInUrl)) problems.push('API key in URL');
    if (last?.status === 200 && !r.reply?.includes('Modell: `')) problems.push('no usage line');
    if (problems.length) failed = true;
    console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${name}  (${r.seconds}s)${problems.length ? `  -> ${problems.join('; ')}` : ''}`);
  }
  rmSync(dirname(diffFile), { recursive: true, force: true });
  return failed ? 1 : 0;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'bot') {
  const { comment, opts } = parseBotArgs(args);
  const r = runBot(comment, opts);
  printResult(r);
  process.exit(r.exitCode ?? 1);
} else if (command === 'smoke') {
  process.exit(smoke());
} else {
  console.error('usage: driver.mjs bot "<comment>" [options] | driver.mjs smoke');
  process.exit(2);
}
