---
name: run-gemini-bridge
description: Run, test and drive the Gemini bridge (scripts/gemini-bridge, the /gemini GitHub comment bot). Use when asked to run or start the bridge, simulate a /gemini, /gemini review, /gemini fix or /gemini! comment, check which Gemini model gets picked, smoke-test bot.mjs, or run its tests, without a GitHub runner or API key.
---

The only runnable part of this repo is the Gemini bridge in `scripts/gemini-bridge/`: `bot.mjs` is what `.github/workflows/gemini_bot.yml` runs for a `/gemini` comment, and `bridge.mjs` is a local CLI. Drive it with `.claude/skills/run-gemini-bridge/driver.mjs`. It runs `bot.mjs` exactly like the workflow, against a fake Gemini (`fake-gemini.mjs`, a `node --import` preload) and inside a throwaway copy of the repo. It needs no API key and no network.

All paths are relative to the repo root.

## Prerequisites

Node 22 (verified on v22.22.0; the workflow uses 22). There are no npm dependencies and nothing to install or build. `git` must be on PATH (the driver uses `git diff --no-index` for word diffs).

## Run (agent path)

Run this first after any change to the bridge. It runs the 36 unit tests, then 9 end-to-end bot runs, and checks the model choice, the context files, retries and the reply:

```bash
node .claude/skills/run-gemini-bridge/driver.mjs smoke
```

Every line should read `PASS`, and the exit code is 0. It takes about 2 s, because the 503 case really waits 1 s.

To simulate one comment, use `bot`. It prints each fake Gemini request (model, context files, prompt size), `reply.md` as it would be posted, `GITHUB_OUTPUT`, and a word diff of the files a fix changed:

```bash
node .claude/skills/run-gemini-bridge/driver.mjs bot '/gemini Wofür ist das Repo?'
node .claude/skills/run-gemini-bridge/driver.mjs bot '/gemini fix In der README "neccessary" zu "necessary" korrigieren' --edit README.md neccessary necessary
git diff HEAD~1 HEAD > /tmp/pr.diff
node .claude/skills/run-gemini-bridge/driver.mjs bot '/gemini review Gibt es Risiken?' --diff /tmp/pr.diff --reply 'Keine kritischen Befunde.'
node .claude/skills/run-gemini-bridge/driver.mjs bot '/gemini Kurz?' --fail 503,503,503,503
```

| `bot` option | effect |
|---|---|
| `--reply <text>` | what the fake Gemini answers (default: one German sentence) |
| `--edit <path> <search> <replace>` | answer with a one-edit fix proposal (the JSON `/gemini fix` expects) |
| `--diff <file>` | use this file as the PR diff; `/gemini review` needs it (`git diff A B > file`) |
| `--fail <503,500,…>` | statuses returned before success; exercises the retry path with real 1/3/5 s waits |
| `--keep` | keep the scratch copy (in `/tmp/gemini-bridge-*`) and print its path |

Fake token counts are characters ÷ 4, not real Gemini numbers.

### Direct invocation

Most bridge PRs touch the pure logic in `lib.mjs`. Import it and call it:

```bash
node --input-type=module -e "import { parseCommand, chooseModel, selectFixPaths } from './scripts/gemini-bridge/lib.mjs'; const c = parseCommand('/gemini! fix Tippfehler in der README'); console.log(c, selectFixPaths(c.task), chooseModel({ task: c.task, flagship: c.flagship }));"
```

### Real Gemini

The local CLI calls the real API. Without a key it stops at once, and with a bad key Google answers 400. Both were verified here: the container reaches `generativelanguage.googleapis.com` through its proxy. With a valid key the CLI prints the answer on stdout and the model and token line on stderr.

```bash
node scripts/gemini-bridge/bridge.mjs "Hallo"
GEMINI_API_KEY=invalid-key node scripts/gemini-bridge/bridge.mjs "Hallo"
```

The real end-to-end path is a comment on a pull request, for example `/gemini <Frage>`, posted with the GitHub MCP tools. The workflow answers within about 10 s, and a `/gemini fix` opens a draft PR from a `gemini/<pr>-<run>` branch. This was verified on merged PR #9. Repository issues are disabled, so a merged PR is the place to test.

## Test

```bash
node --test scripts/gemini-bridge/lib.test.mjs scripts/gemini-bridge/bridge.test.mjs
```

36 tests pass. Also run `smoke` above, because the unit tests miss some breakage (see Gotchas).

## Gotchas

- **Unit tests stay green when the model threshold breaks.** The tests compute their inputs from `COMPLEX_CHARS`. When it was mutated from 20 000 to 2 000, all 36 still passed, while `smoke` failed `question -> lite` and `fix CONTRIBUTING applied -> lite`. Treat `smoke` as the real check for model choice.
- **`bot.mjs` exits 0 even when Gemini fails.** It catches every error so the workflow can always post a reply. Judge a run by `reply.md` (`❌ Fehler: …`) and the request log, not by the exit code.
- **`/gemini fix` writes into the current directory.** Never run `bot.mjs` in the real checkout with a fix comment. The driver always works in a copy.
- **A fix's `search` text must occur exactly once in the file.** README.md has repeated lines (`<p align="center">` occurs twice), so a fake edit on such a line is rejected with `"search" kommt in README.md 2× vor`. Pick a unique line.
- **README.md lines are very long.** A line diff of a fix hides the changed word past the terminal width. The driver prints a word diff instead.
- **The full README is 126 KB and prompts.csv is 105 KB.** Any fix that names one of them, or names no file, is over 20 000 characters and goes to `gemini-3.8-flash`. Only a CONTRIBUTING-only fix and short questions stay on `flash-lite`. `gemini-4-argon` only runs on `/gemini!`.
- **Bot comments trigger the workflow too.** The Codex review bot (`chatgpt-codex-connector`) comments on PRs, and each comment starts a `Gemini Bot` run that is skipped by the author check. That is expected.
- **The workflow itself cannot run here.** Checkout, `gh pr create` and the reply step need a GitHub runner. The driver covers everything up to `reply.md` and `GITHUB_OUTPUT` (`applied=true`), which are the files those steps consume.

## Troubleshooting

- **`❌ GEMINI_API_KEY ist nicht gesetzt.`** (exit 1): the local CLI needs a real key. Use the driver, which sets a fake one.
- **`❌ Gemini API 400: API key not valid.`**: the key is wrong. It fails in about 0.3 s without retries, by design.
- **`❌ Fehler: Gemini API 503: … (nach 4 Versuchen)`**: four transient failures in a row. With `--fail` this takes about 9 s of real waiting.
- **Usage output** (exit 2): `bridge.mjs` was called without a question.
- **`❌ Gemini API nicht erreichbar: fetch failed (nach 4 Versuchen)`** after about 9 s: TLS to Google failed, which the bridge treats as a network error and retries. This happened in a scrubbed environment (`env -i`). The container intercepts HTTPS with its own CA, and Node only trusts it through `NODE_EXTRA_CA_CERTS` (set by default here to `/root/.ccr/ca-bundle.crt`). `HTTPS_PROXY` alone does not help, because Node 22's `fetch` ignores it. Keep `NODE_EXTRA_CA_CERTS` in the environment.
