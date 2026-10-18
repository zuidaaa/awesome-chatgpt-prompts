// Pure helpers for the Gemini bridge: command parsing, prompt building, edit parsing and validation.
// No I/O and no network, so everything here is covered by lib.test.mjs.

// Only these files can ever be changed by Gemini. Exact matches, no directory prefixes.
export const ALLOWED_PATHS = ['README.md', 'prompts.csv', 'CONTRIBUTING.md'];
export const MAX_EDITS = 10;
export const MAX_FILE_CHARS = 300_000;
export const MAX_CONTEXT_CHARS = 400_000;

// Model IDs as listed on https://ai.google.dev/gemini-api/docs/models (checked 2026-10-18).
export const MODELS = {
  cheap: 'gemini-3.5-flash-lite',
  standard: 'gemini-3.8-flash',
  flagship: 'gemini-4-argon',
};
// Above COMPLEX_CHARS (task text plus all context) a request counts as large.
export const COMPLEX_CHARS = 20_000;

// Context size limits per mode. The full README is ~126 KB, which would push every answer
// over the cheap-model threshold in chooseModel, so answers only get an excerpt.
export const README_EXCERPT_CHARS = 6_000;
export const MAX_DIFF_CHARS = 100_000;

export function isLarge({ task = '', files = [] }) {
  return task.length + files.reduce((sum, file) => sum + file.content.length, 0) > COMPLEX_CHARS;
}

// Cheapest by default, the standard model for large requests. The flagship is never picked
// automatically: input size cannot tell whether a request is truly hard, so only "/gemini!" asks for it.
export function chooseModel({ task = '', files = [], flagship = false }) {
  if (flagship) return MODELS.flagship;
  return isLarge({ task, files }) ? MODELS.standard : MODELS.cheap;
}

const PATH_MENTIONS = {
  'README.md': /readme/i,
  'prompts.csv': /prompts\.csv|\bcsv\b/i,
  'CONTRIBUTING.md': /contributing/i,
};

// The allowlisted files a fix task names. Naming none means all of them, e.g. for "add a prompt",
// which CONTRIBUTING.md says goes into both README.md and prompts.csv.
export function selectFixPaths(task) {
  const named = ALLOWED_PATHS.filter((path) => PATH_MENTIONS[path].test(task));
  return named.length ? named : ALLOWED_PATHS;
}

// Decides what context each /gemini mode needs. Pure (no I/O), so mode rules are testable
// without mocking the filesystem; the caller reads the raw inputs and passes them in.
// answer: contributing guide + README excerpt. review: PR diff (required, trimmed to the limit).
// fix: every allowlisted file, as read by the caller.
export function buildContext({ mode, allowedFiles = [], contributing = '', readme = '', diff = '' }) {
  if (mode === 'fix') return { files: allowedFiles };
  if (mode === 'answer') {
    return {
      files: [
        { path: 'CONTRIBUTING.md', content: contributing },
        { path: 'README.md (Auszug)', content: readme.slice(0, README_EXCERPT_CHARS) },
      ],
    };
  }
  const trimmed = diff.slice(0, MAX_DIFF_CHARS);
  if (!trimmed) return { error: '❌ `/gemini review` funktioniert nur in Pull Requests.' };
  return { files: [{ path: 'pr.diff', content: trimmed }] };
}

// Edits instead of whole files: README.md and prompts.csv are ~100 KB each, too large to return in full.
export const PROPOSAL_FORMAT = `Antworte NUR mit einem JSON-Objekt dieser Form:
{"summary": "Eine Zeile, max. 70 Zeichen", "edits": [{"path": "<Pfad>", "search": "<exakter bestehender Text>", "replace": "<neuer Text>"}]}
Regeln:
- "path" muss einer von ${ALLOWED_PATHS.join(', ')} sein.
- "search" muss im Dateiinhalt genau einmal vorkommen. Nimm genug Kontext dazu, aber so wenig wie möglich.
- Ändere nur, was der Auftrag verlangt.`;

// Adapted from PAL MCP Server, systemprompts/clink/default_codereviewer.txt (Apache-2.0).
// The caps keep review answers short, which also keeps output tokens down.
export const REVIEW_FORMAT = `Du bekommst den Diff eines Pull Requests. Beantworte den Auftrag anhand dieses Diffs.
Wenn du Probleme nennst:
- Sortiere sie nach Schwere (Kritisch, Hoch, Mittel, Niedrig): Sicherheit, Korrektheit, Wartbarkeit.
- Belege jedes mit Datei und Zeile oder Symbol aus dem Diff, nenne die Auswirkung und eine konkrete Lösung.
- Höchstens 5 Punkte, keine langen Code-Auszüge.
Nenne kurz, was gut ist und bleiben sollte. Schließe mit einer Zusammenfassung in höchstens 3 Sätzen.`;

// One line for the reply footer and the CLI, e.g. "_Modell: `x` · Tokens: 120 ein · 40 aus · 160 gesamt_".
export function formatUsage({ model, usage = {} }) {
  const parts = [`Modell: \`${model}\``];
  const counts = [
    [usage.input, 'ein'],
    [usage.output, 'aus'],
    [usage.total, 'gesamt'],
  ].filter(([value]) => value != null);
  if (counts.length) parts.push(`Tokens: ${counts.map(([value, label]) => `${value} ${label}`).join(' · ')}`);
  return `_${parts.join(' · ')}_`;
}

export class ProposalError extends Error {
  name = 'ProposalError';
}

// "/gemini <Frage>" (answer), "/gemini review <Frage>" (answer with PR diff), "/gemini fix <Auftrag>" (edits).
// "/gemini!" instead of "/gemini" asks for the flagship model. Returns null if the text is not a command.
export function parseCommand(body) {
  const match = body.trim().match(/^\/gemini(!)?(?:\s+(fix|review)\b)?\s*([\s\S]*)$/);
  if (!match) return null;
  return { mode: match[2] ?? 'answer', task: match[3].trim(), flagship: Boolean(match[1]) };
}

export function buildPrompt({ task, files = [] }) {
  const total = files.reduce((sum, file) => sum + file.content.length, 0);
  if (total > MAX_CONTEXT_CHARS) {
    throw new Error(`Kontext zu groß (${total} Zeichen, Limit ${MAX_CONTEXT_CHARS}).`);
  }
  return [`Auftrag:\n${task}`, ...files.map(({ path, content }) => `Datei ${path}:\n${content}`)].join('\n\n');
}

export function parseEdits(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new ProposalError('Die Antwort enthält kein JSON.');

  let proposal;
  try {
    proposal = JSON.parse(match[0]);
  } catch {
    throw new ProposalError('Die Antwort ist kein gültiges JSON.');
  }
  if (typeof proposal.summary !== 'string' || !Array.isArray(proposal.edits)) {
    throw new ProposalError('Das JSON hat nicht das erwartete Format.');
  }
  return proposal;
}

// files: Map of path -> current content. Returns a Map of path -> new content, only for changed files.
// Nothing is returned unless every edit is valid, so the caller never writes a partial proposal.
export function applyEdits(proposal, files) {
  if (proposal.edits.length === 0 || proposal.edits.length > MAX_EDITS) {
    throw new ProposalError(`Erwartet 1 bis ${MAX_EDITS} Edits, erhalten: ${proposal.edits.length}.`);
  }

  const working = new Map(files);
  for (const { path, search, replace } of proposal.edits) {
    if (!ALLOWED_PATHS.includes(path)) {
      throw new ProposalError(`Pfad nicht erlaubt: ${String(path)}.`);
    }
    if (!working.has(path)) {
      throw new ProposalError(`${path} ist nicht im Kontext.`);
    }
    if (typeof search !== 'string' || search === '' || typeof replace !== 'string') {
      throw new ProposalError(`Ungültiger Edit für ${path}.`);
    }

    const content = working.get(path);
    const occurrences = content.split(search).length - 1;
    if (occurrences !== 1) {
      throw new ProposalError(`"search" kommt in ${path} ${occurrences}× vor, erwartet genau 1×.`);
    }

    // Function replacement, so "$&" or "$1" in the replacement text stay literal.
    const updated = content.replace(search, () => replace);
    if (updated.length > MAX_FILE_CHARS) {
      throw new ProposalError(`${path} würde nach dem Edit zu groß.`);
    }
    working.set(path, updated);
  }

  const changed = new Map();
  for (const [path, content] of working) {
    if (content !== files.get(path)) changed.set(path, content);
  }
  return changed;
}
