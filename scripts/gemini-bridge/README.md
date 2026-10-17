# Gemini-Bridge

Gemini als zweiter Mitarbeiter im Projekt: über GitHub-Kommentare oder lokal im Terminal.

## Setup

1. **Secret** `GEMINI_API_KEY` unter *Settings → Secrets and variables → Actions* anlegen.
2. **Variable** `GEMINI_MODEL` mit der Modell-ID anlegen. Es gibt bewusst keinen Standardwert im Code. Die ID vorher auf https://ai.google.dev gegenprüfen.

## GitHub: `/gemini`

Kommentar in einem Issue oder PR (nur Owner, Member und Collaborator):

- `/gemini <Frage>`: Gemini antwortet als Kommentar. Bei PRs wird der Diff als Kontext mitgegeben.
- `/gemini fix <Auftrag>`: Gemini schlägt Änderungen an `README.md`, `prompts.csv` oder `CONTRIBUTING.md` vor. Die Änderungen landen auf einer Branch `gemini/<nr>-<run>` als **Draft-PR**. Gemergt wird nur von Hand.

Der Workflow ist `.github/workflows/gemini_bot.yml`. Er checkt nur den Default-Branch aus, nie den PR-Head.

### Grenzen

- Schreiben geht nur über Edits (`search` muss genau einmal im Dateiinhalt vorkommen) und nur für die drei Dateien oben. Andere Pfade werden abgelehnt.
- Bei Forks eingehende Kommentare haben oft keinen Schreibzugriff. Dann schlägt der Workflow mit einer Fehlermeldung fehl.
- Gemini kann sich irren. Jede Antwort und jeder Vorschlag ist vor der Übernahme zu prüfen.

## Lokal: `bridge.mjs`

```sh
GEMINI_API_KEY=... GEMINI_MODEL=... node scripts/gemini-bridge/bridge.mjs "Ist dieser Absatz verständlich?" --file CONTRIBUTING.md
```

Das Skript schreibt nie Dateien. Mit `--propose` wird der rohe Edit-Vorschlag ausgegeben.

## Tests

```sh
node --test scripts/gemini-bridge/lib.test.mjs scripts/gemini-bridge/bridge.test.mjs
```

Die Tests brauchen kein Netz und keinen API-Key.

## Dateien

- `lib.mjs`: reine Logik (Befehl parsen, Prompt bauen, Edits validieren)
- `bridge.mjs`: Gemini-Client per `fetch` (keine npm-Abhängigkeit) und lokale CLI
- `bot.mjs`: Einstiegspunkt für den Workflow
