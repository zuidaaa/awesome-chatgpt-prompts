#!/usr/bin/env node
// Entry point for .github/workflows/gemini_bot.yml. Reads the /gemini command from the environment, asks Gemini,
// and writes reply.md (and, for "/gemini fix", the validated edits) into OUT_DIR.
// It catches its own errors so the workflow can always post a reply. Only allowlisted files are ever written.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { askGemini } from './bridge.mjs';
import { applyEdits, buildContext, formatUsage, parseCommand, parseEdits, ProposalError, selectFixPaths } from './lib.mjs';

const FOOTER = '---\n_Generiert mit Gemini über die Repo-Bridge (`/gemini`). Vor dem Übernehmen bitte prüfen._';
const SUMMARY_MAX_CHARS = 70;

async function readOptional(path) {
  return readFile(path, 'utf8').catch(() => '');
}

async function handle(outDir) {
  const command = parseCommand(process.env.COMMENT_BODY ?? '');
  if (!command || !command.task) {
    return { text: '❌ Verwendung: `/gemini <Frage>`, `/gemini review <Frage>` (nur PRs) oder `/gemini fix <Auftrag>`' };
  }
  const propose = command.mode === 'fix';

  const allowedFiles = propose
    ? await Promise.all(selectFixPaths(command.task).map(async (path) => ({ path, content: await readFile(path, 'utf8') })))
    : [];
  const contributing = command.mode === 'answer' ? await readFile('CONTRIBUTING.md', 'utf8') : '';
  const readme = command.mode === 'answer' ? await readFile('README.md', 'utf8') : '';
  const diff = command.mode !== 'answer' ? await readOptional(join(outDir, 'pr.diff')) : '';

  const context = buildContext({ mode: command.mode, allowedFiles, contributing, readme, diff });
  if (context.error) return { text: context.error };

  const { text: answer, model, usage } = await askGemini({
    task: command.task,
    files: context.files,
    mode: command.mode,
    flagship: command.flagship,
  });
  const meta = formatUsage({ model, usage });
  if (!propose) return { text: answer, meta };

  let proposal;
  let changed;
  try {
    proposal = parseEdits(answer);
    changed = applyEdits(proposal, new Map(context.files.map((file) => [file.path, file.content])));
  } catch (error) {
    // The tokens are spent even when the proposal is rejected, so the usage line still belongs in the reply.
    error.meta = meta;
    throw error;
  }
  if (changed.size === 0) {
    return { text: `Keine Änderung nötig: ${proposal.summary}`, meta };
  }

  for (const [path, content] of changed) {
    await writeFile(path, content);
  }
  const summary = proposal.summary.trim().slice(0, SUMMARY_MAX_CHARS);
  await writeFile(join(outDir, 'summary.txt'), `${summary}\n`);
  return {
    text: `**Vorschlag:** ${summary}\n\nGeänderte Dateien: ${[...changed.keys()].map((p) => `\`${p}\``).join(', ')}`,
    meta,
    applied: true,
  };
}

async function main() {
  const outDir = process.env.OUT_DIR;
  if (!outDir) throw new Error('OUT_DIR ist nicht gesetzt.');
  await mkdir(outDir, { recursive: true });

  let result;
  try {
    result = await handle(outDir);
  } catch (error) {
    const label = error instanceof ProposalError ? 'Vorschlag verworfen' : 'Fehler';
    result = { text: `❌ ${label}: ${error.message}`, meta: error.meta };
  }

  const footer = result.meta ? `${FOOTER}\n\n${result.meta}` : FOOTER;
  await writeFile(join(outDir, 'reply.md'), `${result.text}\n\n${footer}\n`);
  if (result.applied && process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, 'applied=true\n');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
