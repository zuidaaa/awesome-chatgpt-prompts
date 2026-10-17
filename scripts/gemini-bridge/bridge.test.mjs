import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from './bridge.mjs';

const okResponse = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: 'Hallo ' }, { text }] } }] }),
});

test('generate sends the key in a header and the model in the path', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return okResponse('Antwort');
  };

  const text = await generate({ apiKey: 'k-123', model: 'my-model', system: 'sys', prompt: 'frage', fetchImpl });

  assert.equal(text, 'Hallo Antwort');
  assert.match(seen.url, /\/models\/my-model:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'k-123');
  assert.equal(seen.body.systemInstruction.parts[0].text, 'sys');
  assert.equal(seen.body.contents[0].parts[0].text, 'frage');
  assert.equal(seen.url.includes('k-123'), false, 'API key must not appear in the URL');
});

test('generate surfaces API errors without leaking the key', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    json: async () => ({ error: { message: 'model not found' } }),
  });

  await assert.rejects(
    generate({ apiKey: 'secret-key', model: 'missing', system: 's', prompt: 'p', fetchImpl }),
    (error) => /Gemini API 404: model not found/.test(error.message) && !error.message.includes('secret-key'),
  );
});

test('generate reports an empty answer with its finish reason', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
  });

  await assert.rejects(
    generate({ apiKey: 'k', model: 'm', system: 's', prompt: 'p', fetchImpl }),
    /finishReason: SAFETY/,
  );
});
