import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, isRetryable, RETRY_DELAYS_MS } from './bridge.mjs';

const okResponse = (text, usageMetadata) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: 'Hallo ' }, { text }] } }], usageMetadata }),
});

const errorResponse = (status, message) => ({
  ok: false,
  status,
  statusText: 'Error',
  json: async () => ({ error: { message } }),
});

// Replays the given responses in order. A function entry is called instead (e.g. to throw a network error).
function scripted(...responses) {
  const calls = { count: 0 };
  const fetchImpl = async () => {
    const next = responses[Math.min(calls.count++, responses.length - 1)];
    return typeof next === 'function' ? next() : next;
  };
  return { fetchImpl, calls };
}

const sleeps = [];
const sleep = async (ms) => sleeps.push(ms);
const base = { apiKey: 'k', model: 'm', system: 's', prompt: 'p', sleep };

test('generate sends the key in a header and the model in the path', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return okResponse('Antwort');
  };

  const { text } = await generate({ apiKey: 'k-123', model: 'my-model', system: 'sys', prompt: 'frage', fetchImpl });

  assert.equal(text, 'Hallo Antwort');
  assert.match(seen.url, /\/models\/my-model:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'k-123');
  assert.equal(seen.body.systemInstruction.parts[0].text, 'sys');
  assert.equal(seen.body.contents[0].parts[0].text, 'frage');
  assert.equal(seen.url.includes('k-123'), false, 'API key must not appear in the URL');
});

test('generate returns the token usage Gemini reports', async () => {
  const { fetchImpl } = scripted(okResponse('x', { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 175 }));
  const { usage } = await generate({ ...base, fetchImpl });
  assert.deepEqual(usage, { input: 120, output: 40, total: 175 });
});

test('generate reports null usage when Gemini sends none', async () => {
  const { fetchImpl } = scripted(okResponse('x'));
  const { usage } = await generate({ ...base, fetchImpl });
  assert.deepEqual(usage, { input: null, output: null, total: null });
});

test('generate surfaces API errors without leaking the key', async () => {
  const { fetchImpl } = scripted(errorResponse(404, 'model not found'));
  await assert.rejects(
    generate({ ...base, apiKey: 'secret-key', fetchImpl }),
    (error) => /Gemini API 404: model not found/.test(error.message) && !error.message.includes('secret-key'),
  );
});

test('generate retries a transient error and then succeeds', async () => {
  sleeps.length = 0;
  const { fetchImpl, calls } = scripted(errorResponse(503, 'unavailable'), errorResponse(500, 'internal'), okResponse('ok'));
  const { text } = await generate({ ...base, fetchImpl });
  assert.equal(text, 'Hallo ok');
  assert.equal(calls.count, 3);
  assert.deepEqual(sleeps, RETRY_DELAYS_MS.slice(0, 2));
});

test('generate retries a network error', async () => {
  const { fetchImpl, calls } = scripted(() => {
    throw new TypeError('fetch failed');
  }, okResponse('ok'));
  const { text } = await generate({ ...base, fetchImpl });
  assert.equal(text, 'Hallo ok');
  assert.equal(calls.count, 2);
});

test('generate gives up after the last retry and says how often it tried', async () => {
  const { fetchImpl, calls } = scripted(errorResponse(503, 'unavailable'));
  await assert.rejects(generate({ ...base, fetchImpl }), /Gemini API 503: unavailable \(nach 4 Versuchen\)/);
  assert.equal(calls.count, RETRY_DELAYS_MS.length + 1);
});

test('generate does not retry auth, billing or bad-request errors', async () => {
  for (const [status, message] of [
    [400, 'API key not valid'],
    [402, 'prepayment credits depleted'],
    [403, 'blocked'],
    [429, 'Quota exceeded for this project'],
  ]) {
    const { fetchImpl, calls } = scripted(errorResponse(status, message));
    await assert.rejects(generate({ ...base, fetchImpl }), new RegExp(`Gemini API ${status}`));
    assert.equal(calls.count, 1, `status ${status} must not be retried`);
  }
});

test('isRetryable treats a plain rate limit as transient and an exhausted quota as final', () => {
  assert.equal(isRetryable(429, 'Too many requests'), true);
  assert.equal(isRetryable(429, 'Quota exceeded'), false);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(401), false);
});

test('generate names the block reason when the prompt is blocked', async () => {
  const { fetchImpl } = scripted({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) });
  await assert.rejects(generate({ ...base, fetchImpl }), /Prompt blockiert \(blockReason: SAFETY\)/);
});

test('generate reports an empty answer with its finish reason', async () => {
  const { fetchImpl } = scripted({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
  });
  await assert.rejects(generate({ ...base, fetchImpl }), /finishReason: SAFETY/);
});
