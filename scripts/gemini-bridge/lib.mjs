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
// Above this input size the flagship model is used. Below it, the cheapest model answers questions.
export const COMPLEX_CHARS = 20_000;

// Cheapest model by default. Edits get the standard model, very large inputs get the flagship.
export function chooseModel({ task, files = [], propose = false }) {
  const size = task.length + files.reduce((sum, file) => sum + file.content.length, 0);
  if (size > COMPLEX_CHARS) return MODELS.flagship;
  return propose ? MODELS.standard : MODELS.cheap;
}

// Edits instead of whole files: README.md and prompts.csv are ~100 KB each, too large to return in full.
export const PROPOSAL_FORMAT = `Antworte NUR mit einem JSON-Objekt dieser Form:
{"summary": "Eine Zeile, max. 70 Zeichen", "edits": [{"path": "<Pfad>", "search": "<exakter bestehender Text>", "replace": "<neuer Text>"}]}
Regeln:
- "path" muss einer von ${ALLOWED_PATHS.join(', ')} sein.
- "search" muss im Dateiinhalt genau einmal vorkommen. Nimm genug Kontext dazu, aber so wenig wie möglich.
- Ändere nur, was der Auftrag verlangt.`;

export class ProposalError extends Error {
  name = 'ProposalError';
}

// "/gemini <Frage>" (answer), "/gemini review <Frage>" (answer with PR diff), "/gemini fix <Auftrag>" (edits).
// Returns null if the text is not a command.
export function parseCommand(body) {
  const match = body.trim().match(/^\/gemini(?:\s+(fix|review)\b)?\s*([\s\S]*)$/);
  if (!match) return null;
  return { mode: match[1] ?? 'answer', task: match[2].trim() };
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
