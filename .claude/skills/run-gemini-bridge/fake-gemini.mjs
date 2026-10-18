// Preload (node --import) that replaces global fetch with a fake Gemini API.
// Configured by env vars set by driver.mjs:
//   FAKE_REPLY  text Gemini "answers" (default: a short German sentence)
//   FAKE_FAIL   comma-separated HTTP statuses returned before the success, e.g. "503,500"
//   FAKE_LOG    file that gets one JSON line per request (model, context files, sizes)
import { appendFileSync } from 'node:fs';

const failures = (process.env.FAKE_FAIL ?? '').split(',').filter(Boolean).map(Number);

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const prompt = body.contents[0].parts[0].text;
  const entry = {
    model: decodeURIComponent(String(url).split('/models/')[1].split(':')[0]),
    files: [...prompt.matchAll(/^Datei (.+?):$/gm)].map((m) => m[1]),
    promptChars: prompt.length,
    systemStart: body.systemInstruction.parts[0].text.slice(0, 60),
    keyInUrl: String(url).includes(init.headers['x-goog-api-key']),
  };

  const status = failures.shift();
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ ...entry, status: status ?? 200 })}\n`);
  if (status) {
    return { ok: false, status, statusText: 'Fake', json: async () => ({ error: { message: `fake ${status}` } }) };
  }

  const text = process.env.FAKE_REPLY ?? 'Das ist eine Fake-Antwort.';
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: Math.ceil(prompt.length / 4), candidatesTokenCount: Math.ceil(text.length / 4), totalTokenCount: Math.ceil((prompt.length + text.length) / 4) },
    }),
  };
};
