import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEdits,
  buildPrompt,
  chooseModel,
  COMPLEX_CHARS,
  MAX_EDITS,
  MAX_FILE_CHARS,
  MODELS,
  parseCommand,
  parseEdits,
  ProposalError,
  VERY_COMPLEX_CHARS,
} from './lib.mjs';

const files = new Map([
  ['README.md', '# Title\n\nAlpha line\nBeta line\n'],
  ['prompts.csv', 'act,prompt\n"Coach","Be kind"\n'],
]);

const edit = (overrides) => ({ summary: 'Test', edits: [{ path: 'README.md', search: 'Alpha line', replace: 'Gamma line', ...overrides }] });

test('parseCommand recognises answer, review and fix modes', () => {
  assert.deepEqual(parseCommand('/gemini what is this?'), { mode: 'answer', task: 'what is this?' });
  assert.deepEqual(parseCommand('/gemini review check the diff'), { mode: 'review', task: 'check the diff' });
  assert.deepEqual(parseCommand('/gemini fix add a typo fix'), { mode: 'fix', task: 'add a typo fix' });
  assert.deepEqual(parseCommand('/gemini fix'), { mode: 'fix', task: '' });
  assert.deepEqual(parseCommand('/gemini fixing things'), { mode: 'answer', task: 'fixing things' });
  assert.deepEqual(parseCommand('/gemini reviewing things'), { mode: 'answer', task: 'reviewing things' });
  assert.equal(parseCommand('hello /gemini'), null);
});

const sized = (chars) => [{ path: 'README.md', content: 'x'.repeat(chars) }];

test('chooseModel uses the cheapest model for a short question', () => {
  assert.equal(chooseModel({ mode: 'answer', task: 'Kurze Frage?' }), MODELS.cheap);
  assert.equal(chooseModel({ task: 'Kurze Frage?' }), MODELS.cheap);
});

test('chooseModel uses the standard model for a review of a small diff', () => {
  assert.equal(chooseModel({ mode: 'review', task: 'Prüfen', files: sized(1_000) }), MODELS.standard);
});

test('chooseModel uses the standard model for a small fix', () => {
  assert.equal(chooseModel({ mode: 'fix', task: 'Typo beheben', files: sized(1_000) }), MODELS.standard);
});

test('chooseModel moves a large answer up to standard and a very large one to flagship', () => {
  assert.equal(chooseModel({ mode: 'answer', task: 'Frage', files: sized(COMPLEX_CHARS) }), MODELS.standard);
  assert.equal(chooseModel({ mode: 'answer', task: 'Frage', files: sized(VERY_COMPLEX_CHARS) }), MODELS.flagship);
});

test('chooseModel uses the flagship for a large fix but not a large review', () => {
  assert.equal(chooseModel({ mode: 'fix', task: 'Fix', files: sized(COMPLEX_CHARS) }), MODELS.flagship);
  assert.equal(chooseModel({ mode: 'review', task: 'Prüfen', files: sized(COMPLEX_CHARS) }), MODELS.standard);
});

test('chooseModel counts the task text towards the size band', () => {
  assert.equal(chooseModel({ mode: 'answer', task: 'x'.repeat(COMPLEX_CHARS + 1) }), MODELS.standard);
  assert.equal(chooseModel({ mode: 'answer', task: 'x'.repeat(VERY_COMPLEX_CHARS + 1) }), MODELS.flagship);
});

test('buildPrompt rejects context that exceeds the limit', () => {
  const big = { path: 'README.md', content: 'x'.repeat(400_001) };
  assert.throws(() => buildPrompt({ task: 'x', files: [big] }), /Kontext zu groß/);
});

test('parseEdits extracts JSON surrounded by prose or a code fence', () => {
  const text = 'Hier ist mein Vorschlag:\n```json\n{"summary": "Fix", "edits": []}\n```';
  assert.deepEqual(parseEdits(text), { summary: 'Fix', edits: [] });
});

test('parseEdits rejects missing, invalid or misshapen JSON', () => {
  assert.throws(() => parseEdits('kein JSON hier'), ProposalError);
  assert.throws(() => parseEdits('{"summary": ,}'), ProposalError);
  assert.throws(() => parseEdits('{"summary": 1, "edits": []}'), ProposalError);
});

test('applyEdits applies a single unique replacement', () => {
  const changed = applyEdits(edit({}), files);
  assert.equal(changed.get('README.md'), '# Title\n\nGamma line\nBeta line\n');
  assert.equal(changed.has('prompts.csv'), false);
});

test('applyEdits applies sequential edits to the same file', () => {
  const proposal = {
    summary: 'Two edits',
    edits: [
      { path: 'README.md', search: 'Alpha', replace: 'One' },
      { path: 'README.md', search: 'One line', replace: 'Two line' },
    ],
  };
  assert.equal(applyEdits(proposal, files).get('README.md'), '# Title\n\nTwo line\nBeta line\n');
});

test('applyEdits treats $ patterns in the replacement as literal text', () => {
  const changed = applyEdits(edit({ replace: 'costs $& and $1' }), files);
  assert.match(changed.get('README.md'), /costs \$& and \$1/);
});

test('applyEdits returns nothing for a no-op edit', () => {
  assert.equal(applyEdits(edit({ search: 'Alpha line', replace: 'Alpha line' }), files).size, 0);
});

test('applyEdits rejects paths outside the allowlist', () => {
  for (const path of ['../README.md', '/etc/passwd', 'scripts/gemini-bridge/bot.mjs', '.github/workflows/gemini_bot.yml', 'README.md/', 'readme.md']) {
    assert.throws(() => applyEdits(edit({ path }), files), /Pfad nicht erlaubt/, path);
  }
});

test('applyEdits rejects allowlisted files that are not in the context', () => {
  assert.throws(
    () => applyEdits({ summary: 's', edits: [{ path: 'CONTRIBUTING.md', search: 'a', replace: 'b' }] }, files),
    /nicht im Kontext/,
  );
});

test('applyEdits requires the search text to occur exactly once', () => {
  assert.throws(() => applyEdits(edit({ search: 'Missing' }), files), /0×/);
  assert.throws(() => applyEdits(edit({ search: 'line' }), files), /2×/);
});

test('applyEdits rejects empty search text and too many edits', () => {
  assert.throws(() => applyEdits(edit({ search: '' }), files), /Ungültiger Edit/);
  const many = { summary: 's', edits: Array.from({ length: MAX_EDITS + 1 }, () => ({ path: 'README.md', search: 'a', replace: 'b' })) };
  assert.throws(() => applyEdits(many, files), /Erwartet 1 bis/);
  assert.throws(() => applyEdits({ summary: 's', edits: [] }, files), /Erwartet 1 bis/);
});

test('applyEdits rejects results that grow past the file limit', () => {
  assert.throws(() => applyEdits(edit({ replace: 'x'.repeat(MAX_FILE_CHARS) }), files), /zu groß/);
});
