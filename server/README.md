# F1 Hub Server

Läuft im Heimnetz auf einem kleinen Rechner und liefert der App drei Dinge, die eine
reine Webseite nicht selbst holen kann. Ohne ihn fehlen **Live-Timing** und **News**;
alles andere – Kalender, Ergebnisse, WM-Stände, Analyse, Telemetrie – holt der Browser
direkt von Jolpica und OpenF1 und funktioniert auch ohne den Server.

## Warum es ihn überhaupt braucht

Keine der Quellen erlaubt Browser-Zugriff: weder `livetiming.formula1.com` noch die
sechs RSS-Feeds senden einen `Access-Control-Allow-Origin`-Header. Der Server setzt ihn
selbst und ist damit die CORS-Brücke. Dazu kommt, dass das Live-Timing eine dauerhafte
SignalR-Verbindung verlangt, die eine Seite ohne Hintergrundprozess nicht halten kann.

## Endpunkte

| Pfad | Inhalt |
| --- | --- |
| `/api/live` | Zusammengeführter Stand des Live-Timings. `?v=<version>` antwortet mit `204`, wenn sich seit der letzten Abfrage nichts geändert hat |
| `/api/live/status` | Kurzfassung für das Menü: läuft gerade eine Session |
| `/api/news` | Artikel aus sechs Feeds, entdoppelt, mit `removed`-Zähler |
| `/api/reminders` | Status der Discord-Erinnerungen |
| `/api/health` | Für den Container-Healthcheck |
| alles andere | Statische Dateien aus `public/` |

## Dateien

- `src/livetiming.js` – SignalR-Client, führt die Deltas zum Gesamtstand zusammen
- `src/news.js` – RSS-Aggregator samt Entdopplung
- `src/reminders.js` – Discord-Nachrichten vor Sessions und nach dem Rennen
- `src/server.js` – HTTP-Server und Routen

## Zwei Eigenheiten des F1-Feeds

**Unbekannte Topics werden stillschweigend ignoriert.** `Subscribe` meldet immer „ok";
ob ein Name gültig war, zeigt erst der Snapshot, der nur die gültigen enthält. Positionen
und Telemetrie (`Position.z`, `CarData.z`) werden über `/signalrcore` **nicht** angeboten,
und der alte `/signalr`-Endpunkt antwortet mit `401`. Eine Streckenkarte mit Fahrerpunkten
ist damit über den freien Zugang nicht baubar.

**`PitLaneTimeCollection` ist ein Benachrichtigungsstrom, kein Archiv.** F1 meldet einen
Stopp und löscht den Eintrag kurz darauf wieder. Wer nur den aktuellen Stand durchreicht,
zeigt fast immer eine leere Liste – deshalb schreibt `livetiming.js` die Stopps mit und
leert die Mitschrift beim Sessionwechsel.

## Betrieb

Die App erwartet den Server unter `http://<host>:8790`. Der Client wählt die Adresse in
`live.js` selbst: über HTTPS ausgeliefert gibt es keinen Server (eine HTTPS-Seite darf
keinen HTTP-Dienst im Heimnetz abfragen, Live und News werden dann ausgeblendet), unter
`localhost` und beim direkten Öffnen der Datei wird die feste Heimnetz-Adresse benutzt,
sonst die eigene Herkunft. Zum Überschreiben:
`localStorage.setItem('f1:server', 'http://…')`.

Verzeichnis auf dem Server:

```
f1hub/
  src/            aus diesem Repo
  public/         die Client-Dateien aus dem Repo-Wurzelverzeichnis
  data/           Zustand der Erinnerungen, als Volume eingebunden
  .env            NICHT im Repo, siehe .env.example
```

`public/` ist eine Kopie der Client-Dateien, kein Checkout – nach Änderungen an `app.js`,
`live.js`, `style.css` und so weiter müssen diese dorthin übertragen werden.

Starten und nach Änderungen an `src/` neu bauen:

```bash
docker compose up -d --build
```

Der Neustart trennt die Verbindung zum Live-Timing für etwa fünfzehn Sekunden; danach
holt sich der Client einen frischen Snapshot. Während einer laufenden Session gehen dabei
die mitgeschriebenen Boxenstoppzeiten verloren, weil F1 im Snapshot nur den jeweils
letzten Stopp mitliefert.
