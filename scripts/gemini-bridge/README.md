# Gemini-Bridge

Gemini als zweiter Mitarbeiter im Projekt: über GitHub-Kommentare oder lokal im Terminal.

## Setup

1. **Secret** `GEMINI_API_KEY` unter *Settings → Secrets and variables → Actions* anlegen.

Die Modellwahl (`chooseModel` in `lib.mjs`) ist so sparsam wie möglich:

| Anfrage | Modell |
| --- | --- |
| Standard, Auftrag plus Kontext bis 20 000 Zeichen | `gemini-3.5-flash-lite` |
| Groß, über 20 000 Zeichen, etwa ein großer Diff oder ein Fix an `README.md` oder `prompts.csv` | `gemini-3.8-flash` |
| Nur auf ausdrücklichen Wunsch mit `/gemini!` | `gemini-4-argon` |

Das Flagship-Modell wird nie automatisch gewählt. An der Zeichenzahl lässt sich nicht erkennen, ob eine Anfrage wirklich schwer ist. Gedacht ist `/gemini!` für Ausnahmen: äußerst schwere Fragen oder Reviews, oder wenn die Antwort eines anderen Modells zweifelhaft war.

Bei `fix` muss Gemini keine ganze Datei schreiben, sondern nur einzelne Stellen ersetzen. Jede Ersetzung wird geprüft: Der gesuchte Text muss genau einmal vorkommen. Ein ungenauer Vorschlag wird verworfen und nicht übernommen.

Die Modell-IDs stehen unter https://ai.google.dev/gemini-api/docs/models. Zum Ändern die Konstanten `MODELS` und `COMPLEX_CHARS` in `lib.mjs` anpassen.

## GitHub: `/gemini`

Kommentar in einem Issue oder PR (nur Owner, Member und Collaborator):

- `/gemini <Frage>`: Gemini antwortet als Kommentar. Kontext sind `CONTRIBUTING.md` und der Anfang der `README.md` (6 000 Zeichen). Kein Diff.
- `/gemini review <Frage>`: Wie oben, aber mit dem PR-Diff als Kontext. Funktioniert nur in Pull Requests. Gefundene Probleme kommen nach Schwere sortiert, mit Datei und Zeile, höchstens fünf.
- `/gemini fix <Auftrag>`: Gemini schlägt Änderungen an `README.md`, `prompts.csv` oder `CONTRIBUTING.md` vor. Nennt der Auftrag eine dieser Dateien („README“, „csv“, „CONTRIBUTING“), wird nur diese mitgeschickt. Das spart Input-Tokens. Nennt er keine, gehen alle drei mit, etwa für „neuen Prompt hinzufügen“, der laut `CONTRIBUTING.md` in README und CSV gehört. Die Änderungen landen auf einer Branch `gemini/<nr>-<run>` als **Draft-PR**. Gemergt wird nur von Hand.
- `/gemini! …`: Wie die drei Befehle oben (`/gemini! <Frage>`, `/gemini! review …`, `/gemini! fix …`), aber mit `gemini-4-argon`. Das ist teuer und nur für Ausnahmen gedacht.

Der Workflow ist `.github/workflows/gemini_bot.yml`. Er checkt nur den Default-Branch aus, nie den PR-Head.

Jede Antwort, die Gemini erreicht hat, endet mit dem gewählten Modell und dem Token-Verbrauch, den Gemini meldet. Das gilt auch, wenn ein Vorschlag verworfen wird, denn die Tokens sind dann schon verbraucht.

### Fehler und Wiederholungen

Vorübergehende Fehler wiederholt die Bridge bis zu viermal, mit Pausen von 1, 3 und 5 Sekunden. Vorübergehend sind Netzwerkfehler, Zeitüberschreitung (120 s), 408, 5xx und 429 ohne Hinweis auf ein erschöpftes Kontingent. Sofort abgebrochen wird bei ungültigem Key (400), fehlendem Guthaben (402), Sperre (403) und erschöpftem Kontingent. Ein gesperrter Prompt wird mit `blockReason` gemeldet.

### Grenzen

- Schreiben geht nur über Edits (`search` muss genau einmal im Dateiinhalt vorkommen) und nur für die drei Dateien oben. Andere Pfade werden abgelehnt.
- Bei Forks eingehende Kommentare haben oft keinen Schreibzugriff. Dann schlägt der Workflow mit einer Fehlermeldung fehl.
- Gemini kann sich irren. Jede Antwort und jeder Vorschlag ist vor der Übernahme zu prüfen.

## Lokal: `bridge.mjs`

```sh
GEMINI_API_KEY=... node scripts/gemini-bridge/bridge.mjs "Ist dieser Absatz verständlich?" --file CONTRIBUTING.md
```

Das Skript schreibt nie Dateien. Mit `--propose` wird der rohe Edit-Vorschlag ausgegeben, mit `--flagship` wird `gemini-4-argon` genutzt.

Die Antwort steht auf stdout, Modell und Token-Verbrauch auf stderr. So kann ein anderes Werkzeug, etwa Claude Code, Gemini eine große Datei lesen lassen und bekommt nur die kurze Antwort in seinen Kontext.

## Tests

```sh
node --test scripts/gemini-bridge/lib.test.mjs scripts/gemini-bridge/bridge.test.mjs
```

Die Tests brauchen kein Netz und keinen API-Key.

## Dateien

- `lib.mjs`: reine Logik (Befehl parsen, Kontext pro Modus bauen, Prompt bauen, Edits validieren)
- `bridge.mjs`: Gemini-Client per `fetch` (keine npm-Abhängigkeit) und lokale CLI
- `bot.mjs`: Einstiegspunkt für den Workflow

## Übernommene Muster

Retry-Logik und Fehlereinteilung (`bridge.mjs`) sowie die Review-Anweisung (`REVIEW_FORMAT` in `lib.mjs`) sind angelehnt an den [PAL MCP Server](https://github.com/BeehiveInnovations/pal-mcp-server) (`providers/gemini.py`, `systemprompts/clink/default_codereviewer.txt`, Stand Commit `7afc7c1`). Der steht unter der [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). Der Code wurde nicht kopiert, sondern als Muster nach JavaScript übertragen und angepasst.
