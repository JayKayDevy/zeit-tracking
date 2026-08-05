# saas.do-Connector

Der Organizer-Server (Render) wird beim Zugriff auf `app.dev.saas.toyota.de` von einer
vorgeschalteten Azure-WAF blockiert (IP-basiert, unabhängig von Zugangsdaten oder Headers).
Dieses kleine Script läuft stattdessen auf deinem eigenen, bei saas.do bereits autorisierten
Rechner, holt dort die Versionsdaten und schickt sie an den Organizer weiter. Der Server
selbst kontaktiert saas.do nicht mehr.

## Einrichtung (einmalig)

1. `cp connector/.env.example connector/.env`
2. In `connector/.env` eintragen:
   - `SAASDO_USERNAME` / `SAASDO_PASSWORD` – deine saas.do-Zugangsdaten
   - `ORGANIZER_TOKEN` – im Organizer im Browser einloggen, DevTools öffnen →
     Application/Storage → Local Storage → `zt_token` kopieren
3. `npm install` im Projekt-Hauptverzeichnis (falls noch nicht geschehen) – der Connector
   nutzt die dort bereits installierte `dotenv`-Abhängigkeit.

`connector/.env` wird durch die bestehende `.gitignore`-Regel `.env` automatisch nicht
mitversioniert. Trotzdem vor dem ersten Commit einmal mit `git status` prüfen.

## Nutzung

```
node connector/saasdo-sync.js
```

Das Script:
1. Holt deine aktiven saas.do-Apps aus den Organizer-Einstellungen.
2. Loggt sich bei saas.do ein.
3. Ruft pro aktiver App die Versionsdaten ab und filtert sie direkt auf den in den
   Organizer-Einstellungen hinterlegten Autor (`saasdo_author`) - es werden nur deine
   eigenen Commits übertragen, nicht die volle App-Historie.
4. Schickt die Rohdaten an den Organizer (`POST /api/saasdo/sync`).

Anschließend zeigt „Entwicklung prüfen" im Organizer die neuen Commits.

## Der `ORGANIZER_TOKEN` läuft irgendwann ab

Nach ca. 30 Tagen wird der kopierte Token ungültig; das Script meldet das klar
(„Organizer-Token abgelehnt"). Dann einfach erneut aus dem Browser kopieren und in
`connector/.env` ersetzen.

## Automatisch ausführen (optional)

Das Script macht nichts von selbst periodisch – wer das möchte, kann es selbst per
`cron` (macOS/Linux) oder Aufgabenplanung (Windows) regelmäßig laufen lassen, z.B.:

```
# crontab -e, jeden Morgen um 8 Uhr
0 8 * * * cd /pfad/zum/projekt && node connector/saasdo-sync.js >> connector/sync.log 2>&1
```

## Sicherheit

- Zugangsdaten liegen ausschließlich lokal in `connector/.env`, werden nirgendwo
  hochgeladen außer direkt an `app.dev.saas.toyota.de` (deine eigene Anmeldung).
- Der Organizer erhält nur die rohen Versions-/Commit-Daten der von dir konfigurierten
  Apps – keine Zugangsdaten.
- Der `ORGANIZER_TOKEN` gewährt denselben Zugriff wie dein normaler Web-Login auf deinen
  eigenen Account, nicht mehr.
