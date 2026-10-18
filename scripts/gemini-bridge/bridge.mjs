#!/usr/bin/env node
// Thin client for the Gemini API, plus a local CLI. Uses global fetch (Node 18+), so there are no npm dependencies.
//
//   GEMINI_API_KEY=... node scripts/gemini-bridge/bridge.mjs "<Frage>" [--file README.md] [--propose]
//
// The CLI only prints. It never writes files; the GitHub workflow (bot.mjs) is the only place that applies edits.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildPrompt, chooseModel, PROPOSAL_FORMAT } from './lib.mjs';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const SYSTEM = 'Du bist ein Projektassistent für ein Repository mit Prompt-Sammlungen. Antworte auf Deutsch, knapp, sachlich und kritisch.';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ist nicht gesetzt.`);
  return value;
}

export async function generate({ apiKey, model, system, prompt, fetchImpl = fetch }) {
  const response = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gemini API ${response.status}: ${data.error?.message ?? response.statusText}`);
  }

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('');
  if (!text) {
    throw new Error(`Leere Antwort (finishReason: ${candidate?.finishReason ?? 'unbekannt'}).`);
  }
  return text;
}

// Reads GEMINI_API_KEY from the environment. The model is chosen by mode and input size, see chooseModel in lib.mjs.
export async function askGemini({ task, files = [], mode = 'answer', fetchImpl }) {
  const propose = mode === 'fix';
  return generate({
    apiKey: requireEnv('GEMINI_API_KEY'),
    model: chooseModel({ mode, task, files }),
    system: propose ? `${SYSTEM}\n\n${PROPOSAL_FORMAT}` : SYSTEM,
    prompt: buildPrompt({ task, files }),
    fetchImpl,
  });
}

function parseArgs(argv) {
  const task = [];
  const files = [];
  let propose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') files.push(argv[++i]);
    else if (argv[i] === '--propose') propose = true;
    else task.push(argv[i]);
  }
  return { task: task.join(' '), files, propose };
}

async function main() {
  const { task, files, propose } = parseArgs(process.argv.slice(2));
  if (!task) {
    console.error('Usage: node scripts/gemini-bridge/bridge.mjs "<Frage>" [--file <pfad>]... [--propose]');
    process.exit(2);
  }

  const context = await Promise.all(
    files.map(async (path) => ({ path, content: await readFile(path, 'utf8') })),
  );
  console.log(await askGemini({ task, files: context, mode: propose ? 'fix' : 'answer' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  });
}
