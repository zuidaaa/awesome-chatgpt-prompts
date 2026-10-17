#!/usr/bin/env node
// Entry point for .github/workflows/gemini_bot.yml. Reads the /gemini command from the environment, asks Gemini,
// and writes reply.md (and, for "/gemini fix", the validated edits) into OUT_DIR.
// It catches its own errors so the workflow can always post a reply. Only allowlisted files are ever written.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { askGemini } from './bridge.mjs';
import { ALLOWED_PATHS, applyEdits, parseCommand, parseEdits, ProposalError } from './lib.mjs';

const FOOTER = '---\n_Generiert mit Gemini über die Repo-Bridge (`/gemini`). Vor dem Übernehmen bitte prüfen._';
const MAX_DIFF_CHARS = 100_000;
const SUMMARY_MAX_CHARS = 70;

async function readOptional(path) {
  return readFile(path, 'utf8').catch(() => '');
}

async function handle(outDir) {
  const command = parseCommand(process.env.COMMENT_BODY ?? '');
  if (!command || !command.task) {
    return { text: '❌ Verwendung: `/gemini <Frage>` oder `/gemini fix <Auftrag>`' };
  }

  const files = [];
  if (command.propose) {
    for (const path of ALLOWED_PATHS) {
      files.push({ path, content: await readFile(path, 'utf8') });
    }
  }
  const diff = (await readOptional(join(outDir, 'pr.diff'))).slice(0, MAX_DIFF_CHARS);
  if (diff) files.push({ path: 'pr.diff', content: diff });

  const answer = await askGemini({ task: command.task, files, propose: command.propose });
  if (!command.propose) return { text: answer };

  const proposal = parseEdits(answer);
  const changed = applyEdits(proposal, new Map(files.map((file) => [file.path, file.content])));
  if (changed.size === 0) {
    return { text: `Keine Änderung nötig: ${proposal.summary}` };
  }

  for (const [path, content] of changed) {
    await writeFile(path, content);
  }
  const summary = proposal.summary.trim().slice(0, SUMMARY_MAX_CHARS);
  await writeFile(join(outDir, 'summary.txt'), `${summary}\n`);
  return {
    text: `**Vorschlag:** ${summary}\n\nGeänderte Dateien: ${[...changed.keys()].map((p) => `\`${p}\``).join(', ')}`,
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
    result = { text: `❌ ${label}: ${error.message}` };
  }

  await writeFile(join(outDir, 'reply.md'), `${result.text}\n\n${FOOTER}\n`);
  if (result.applied && process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, 'applied=true\n');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
