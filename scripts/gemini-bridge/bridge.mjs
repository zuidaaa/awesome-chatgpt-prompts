#!/usr/bin/env node
// Thin client for the Gemini API, plus a local CLI. Uses global fetch (Node 18+), so there are no npm dependencies.
//
//   GEMINI_API_KEY=... node scripts/gemini-bridge/bridge.mjs "<Frage>" [--file README.md] [--propose]
//
// The CLI only prints. It never writes files; the GitHub workflow (bot.mjs) is the only place that applies edits.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildPrompt, chooseModel, formatUsage, PROPOSAL_FORMAT, REVIEW_FORMAT } from './lib.mjs';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const SYSTEM = 'Du bist ein Projektassistent für ein Repository mit Prompt-Sammlungen. Antworte auf Deutsch, knapp, sachlich und kritisch.';
const MODE_FORMAT = { answer: '', review: REVIEW_FORMAT, fix: PROPOSAL_FORMAT };

// Retry pattern adapted from PAL MCP Server, providers/gemini.py (Apache-2.0): up to 4 attempts with growing delays,
// and only for transient failures. Billing, auth and bad-request errors fail at once.
export const RETRY_DELAYS_MS = [1_000, 3_000, 5_000];
const REQUEST_TIMEOUT_MS = 120_000;
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);

// A 429 is a per-minute rate limit (worth waiting for) unless the message says the quota or credit is used up.
export function isRetryable(status, message = '') {
  if (status === 429) return !/quota|billing|credit|prepayment/i.test(message);
  return RETRYABLE_STATUS.has(status);
}

class GeminiError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ist nicht gesetzt.`);
  return value;
}

async function requestOnce({ url, apiKey, body, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GeminiError(`Gemini API nicht erreichbar: ${error.message}`, true);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message ?? response.statusText;
    throw new GeminiError(`Gemini API ${response.status}: ${message}`, isRetryable(response.status, message));
  }
  return data;
}

// Returns { text, usage }. usage holds the token counts Gemini reports (null where it reports none).
export async function generate({ apiKey, model, system, prompt, fetchImpl = fetch, sleep = defaultSleep }) {
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  });

  let data;
  for (let attempt = 0; !data; attempt++) {
    try {
      data = await requestOnce({ url, apiKey, body, fetchImpl });
    } catch (error) {
      if (!error.retryable) throw error;
      if (attempt >= RETRY_DELAYS_MS.length) {
        error.message += ` (nach ${attempt + 1} Versuchen)`;
        throw error;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  const candidate = data.candidates?.[0];
  if (!candidate && data.promptFeedback?.blockReason) {
    throw new Error(`Prompt blockiert (blockReason: ${data.promptFeedback.blockReason}).`);
  }
  const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('');
  if (!text) {
    throw new Error(`Leere Antwort (finishReason: ${candidate?.finishReason ?? 'unbekannt'}).`);
  }

  const meta = data.usageMetadata ?? {};
  return {
    text,
    usage: {
      input: meta.promptTokenCount ?? null,
      output: meta.candidatesTokenCount ?? null,
      total: meta.totalTokenCount ?? null,
    },
  };
}

// Reads GEMINI_API_KEY from the environment. The model is chosen by mode and input size, see chooseModel in lib.mjs.
// Returns { text, model, usage }.
export async function askGemini({ task, files = [], mode = 'answer', fetchImpl, sleep }) {
  const model = chooseModel({ mode, task, files });
  const format = MODE_FORMAT[mode];
  const { text, usage } = await generate({
    apiKey: requireEnv('GEMINI_API_KEY'),
    model,
    system: format ? `${SYSTEM}\n\n${format}` : SYSTEM,
    prompt: buildPrompt({ task, files }),
    fetchImpl,
    sleep,
  });
  return { text, model, usage };
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
  const { text, model, usage } = await askGemini({ task, files: context, mode: propose ? 'fix' : 'answer' });
  console.log(text);
  // Usage goes to stderr so stdout stays clean for a caller (e.g. Claude Code) that reads only the answer.
  console.error(formatUsage({ model, usage }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  });
}
