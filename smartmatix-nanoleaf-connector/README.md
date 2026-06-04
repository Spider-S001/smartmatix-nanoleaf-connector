# SmartMatix Nanoleaf Connector

![Das Plugin-Icon von SmartMatix Nanoleaf Connector](/Screenshots/nanoleaf-connector-plugin-icon.png "Plugin-Icon")

Ein Plugin für die **Homematic IP Home Control Unit (HCU)** (@homematicip), das Nanoleaf Matter WiFi Essentials Geräte über die [Nanoleaf Open API](https://forum.nanoleaf.me/docs) in das Homematic IP System einbindet – vollständig lokal und ohne Cloud-Abhängigkeit, über die [Connect API 1.0.1](https://github.com/homematicip/connect-api).

> Entwickelt von **Kevin Schipper** · Plugin-ID: `de.smartmatix.plugin.nanoleaf-connector`

---

## Einsatzmöglichkeiten

Mit dem **SmartMatix Nanoleaf Connector** steuerst du deine Nanoleaf Matter WiFi Essentials Geräte direkt über deine **Homematic IP** Zentrale – ohne Umweg über die Nanoleaf-Cloud. Schalte Nanoleaf Lightstrips, Floor Lamps oder andere kompatible Geräte automatisiert ein und aus, dimme sie oder passe ihre Farbe an – alles über gewohnte Homematic IP Automatisierungen und Szenen.

![So siehst du deine Nanoleafs in der Homematic IP App](/Screenshots/Plugin-Geraete-in-der-HMIP-App-Nanoleaf-Connector.jpg "Darstellung der Nanoleaf-Leuchten in der Homematic IP App")

![Steuerung der Nanoleafs in der Homematic IP App](/Screenshots/Plugin-Geraete-Steuerung-in-der-HMIP-App-Nanoleaf-Connector.jpg "Darstellung der Steuerung von Nanoleaf-Leuchten in der Homematic IP App")

---

## Features

- **Automatische Geräteerkennung** – Subnetz-Scan erkennt Nanoleaf Geräte im lokalen Netzwerk automatisch; alternativ manuelle IP-Eingabe
- **Vollständige Lichtsteuerung** – Ein/Aus, Helligkeit, Farbton, Sättigung und Farbtemperatur
- **Polling-basierter Statusabgleich** – konfigurierbares Intervall (10 s bis 24 h) für die Statusabfrage
- **Authentifizierung per Token-Pairing** – sicherer Verbindungsaufbau zur Nanoleaf API direkt aus den Plugin-Einstellungen
- **Persistenz** – alle Geräte und Konfigurationsdaten werden in `/data` gespeichert und überleben Plugin-Updates und Neustarts
- **Automatische Wiederverbindung** – Exponential Backoff bei Verbindungsabbruch zur HCU
- **Backup & Restore** – alle Plugin-Daten lassen sich als JSON-Datei exportieren und wiederherstellen
- **Automatische Updates** – der Plugin-Updater prüft regelmäßig auf neue Versionen

![Die Einrichtung des Plugins](/Screenshots/Konfiguration-Plugin-Nanoleaf-Connector.jpg "Konfigurationsmöglichkeiten im Nanoleaf Plugin")

![Die Einbindung der Nanoleafs im Plugin](/Screenshots/Konfiguration-Nanoleaf-Plugin-Geraet-Nanoleaf-Connector.jpg "Die Einbindung der Nanoleafs über die Plugin-Oberfläche")

---

## Voraussetzungen

| Voraussetzung | Version |
|---|---|
| Node.js | ≥ 18 |
| HCU-Firmware | ≥ 1.6.16 |
| Nanoleaf-Gerät | Matter WiFi Essentials kompatibel |
| Entwicklermodus | aktiviert (HCUweb) |

---

## Projektstruktur

```
smartmatix-nanoleaf-connector/
├── Dockerfile                        ← Deployment auf der HCU (ARM64)
├── package.json
├── README.md
├── THIRD_PARTY_LICENSES.md
├── constants/
│   └── device_constants.js           ← Gerätetypen & Feature-Definitionen
├── data/
│   ├── config.json                   ← Plugin-Konfiguration (Token, Intervall, etc.)
│   ├── devices.json                  ← HCU-Gerätedefinitionen
│   └── nanoleaf.json                 ← Nanoleaf-Gerätecache mit API-Token
├── lang/
│   └── localization.json             ← Plugin-Übersetzungen (de/en)
└── src/
    ├── index.js                      ← Einstiegspunkt
    ├── plugin.js                     ← WebSocket, Protokoll, Einstellungsmenü
    ├── nanoleaf.js                   ← Nanoleaf REST API Client
    ├── devices.js                    ← Geräteverwaltung & Steuerlogik
    ├── devicesStore.js               ← Persistenz für Geräte & Nanoleaf-Daten
    ├── configStore.js                ← Persistenz für Konfiguration
    ├── backup-plugin-data.js         ← Backup & Restore Bibliothek
    ├── hcu-plugin-updater.js         ← Automatischer Update-Check
    ├── localization.js               ← Übersetzungen ausgeben
    ├── logger.js                     ← Konsolenlogger
    └── notifications.js              ← HCU-Benachrichtigungen
```

---

## Plugin auf der HCU installieren

HCUweb öffnen → **Plugins** → `.tar.gz`-Datei hochladen.

> Der Entwicklermodus muss aktiviert sein.

---

## Ersteinrichtung in der HCUweb

Nach der Installation des Plugins:

1. Plugin-Einstellungen öffnen (`Plugins → Nanoleaf Connector → Einstellungen`)
2. Geräte über **„Netzwerk scannen"** suchen lassen oder eine IP-Adresse manuell eingeben
3. Für jedes gefundene Gerät auf **„Token anfordern"** klicken und am Gerät den Pairing-Button drücken
4. Nach erfolgreichem Pairing wird das Gerät automatisch als Schalter/Dimmer in der HCU angelegt

---

## Einstellungen in der HCUweb

### Allgemein

| Einstellung | Beschreibung | Standard |
|---|---|---|
| **Polling-Intervall** | Intervall für den automatischen Statusabgleich | 60 s |
| **Gelöschte Geräte neu inkludieren** | Meldet beim nächsten Discover bereits entfernte Geräte erneut an | Nein |

### Je Gerät

| Einstellung | Beschreibung |
|---|---|
| **Gerätename** | Anzeigename des Nanoleaf-Geräts (aus der Nanoleaf API) |
| **IP-Adresse** | Aktuelle IP-Adresse des Geräts |
| **Token anfordern** | Startet den Pairing-Vorgang mit dem Nanoleaf-Gerät |
| **API verbunden?** | Zeigt an ob die Verbindung zur Nanoleaf API aktiv ist |

### Backup & Restore

| Einstellung | Beschreibung |
|---|---|
| **Backup-Modus aktivieren** | Exportiert alle Plugin-Daten als JSON-Datei |
| **Restore-Modus aktivieren** | Stellt Plugin-Daten aus einer Backup-Datei wieder her |

---

## Backup & Restore

Das Plugin unterstützt den Export und Import aller Einstellungen und Gerätedaten:

**Backup erstellen:**
1. Backup-Modus in den Plugin-Einstellungen aktivieren und speichern
2. Einstellungen erneut öffnen → Button zum Herunterladen der Backup-Datei erscheint
3. Die Backup-Datei einmalig herunterladen – danach verfällt der Link automatisch

**Backup wiederherstellen:**
1. Restore-Modus in den Plugin-Einstellungen aktivieren und speichern
2. Einstellungen erneut öffnen → Sicherheits-Token und Link zur Restore-Seite erscheinen
3. Restore-Seite öffnen, Token eingeben und Backup-Datei hochladen
4. Das Plugin startet nach erfolgreicher Wiederherstellung automatisch neu

> **Hinweis:** Ein Backup einer neueren Hauptversion (z. B. v2.x) kann nicht in eine ältere Hauptversion (z. B. v1.x) eingespielt werden, um Datenkonflikte zu vermeiden.

---

## Lokale Entwicklung

### 1. Repository klonen & Abhängigkeiten installieren

```bash
git clone https://github.com/Spider-S001/smartmatix-nanoleaf-connector.git
cd smartmatix-nanoleaf-connector
npm install
```

### 2. Aktivierungsschlüssel & Auth-Token erzeugen

In der **HCUweb** (`https://hcu1-XXXX.local`) unter  
`Einstellungen → Entwicklermodus → Aktivierungsschlüssel generieren`

Anschließend über Postman oder curl den Auth-Token generieren (siehe HCU-Dokumentation) und in eine Datei speichern:

```bash
echo "DEIN-AUTHTOKEN" > authtoken.txt
```

### 3. Plugin starten

```bash
node src/index.js de.smartmatix.plugin.nanoleaf-connector hcu1-XXXX.local authtoken.txt
```

Mit Debug-Logging:

```bash
LOG_LEVEL=debug node src/index.js de.smartmatix.plugin.nanoleaf-connector hcu1-XXXX.local authtoken.txt
```

### Log-Level

| Wert | Beschreibung |
|---|---|
| `debug` | Alle Nachrichten inkl. Roh-JSON und API-Antworten |
| `info` | Standard (Default) |
| `warn` | Nur Warnungen und Fehler |
| `error` | Nur Fehler |

---

## Deployment auf der HCU

### 1. Docker-Image bauen

Das Plugin läuft auf der HCU in einem ARM64-Container. Zum Bauen auf einem x86-Rechner wird Docker Buildx benötigt:

```bash
docker buildx build --platform linux/arm64 -t smartmatix-nanoleaf-connector:0.4.0 .
```

### 2. Image exportieren

```bash
docker save smartmatix-nanoleaf-connector:0.4.0 | gzip > smartmatix-nanoleaf-connector-0.4.0.tar.gz
```

#### Unter Windows (anschließend mit 7-Zip zu `.tar.gz` konvertieren)

```bash
docker save smartmatix-nanoleaf-connector:0.4.0 -o smartmatix-nanoleaf-connector-0.4.0.tar
```

### 3. Plugin auf der HCU installieren

HCUweb öffnen → **Plugins** → `.tar.gz`-Datei hochladen.

---

## Protokollablauf

```
Plugin                                    HCU
  │                                        │
  │── WebSocket (wss://<host>:9001) ──────►│
  │   Header: authtoken, plugin-id         │
  │                                        │
  │── PLUGIN_STATE_RESPONSE { READY } ────►│  (sofort beim Verbindungsaufbau)
  │── STATUS_EVENT (alle Geräte) ─────────►│  (gespeicherte Zustände wiederherstellen)
  │                                        │
  │◄── PLUGIN_STATE_REQUEST ───────────────│  (periodisch)
  │── PLUGIN_STATE_RESPONSE { READY } ────►│
  │                                        │
  │◄── DISCOVER_REQUEST ───────────────────│  (HCU sucht Geräte)
  │── DISCOVER_RESPONSE ──────────────────►│  (Nanoleaf-Geräteliste)
  │                                        │
  │◄── CONFIG_TEMPLATE_REQUEST ────────────│  (HCU öffnet Einstellungen)
  │── CONFIG_TEMPLATE_RESPONSE ───────────►│  (Felder je Gerät + allg. Einstellungen)
  │                                        │
  │◄── CONFIG_UPDATE_REQUEST ──────────────│  (Nutzer speichert Einstellungen)
  │── CONFIG_UPDATE_RESPONSE ─────────────►│
  │── DISCOVER_RESPONSE ──────────────────►│  (wenn neue Geräte hinzugekommen sind)
  │                                        │
  │◄── CONTROL_REQUEST ────────────────────│  (HCU steuert ein Gerät)
  │── [Nanoleaf REST API] ────────────────►│  (Befehl an Gerät weiterleiten)
  │── CONTROL_RESPONSE ───────────────────►│
  │                                        │
  │   [alle N Sekunden] ───────────────────│
  │── STATUS_EVENT (je Gerät) ────────────►│  (aktualisierter Gerätezustand)
```

---

## Datenhaltung

Alle persistierten Daten liegen im Verzeichnis `/data` des Containers und überleben Plugin-Updates sowie Neustarts.

| Datei | Inhalt |
|---|---|
| `config.json` | Polling-Intervall, reincludeDevices-Flag |
| `devices.json` | HCU-Gerätedefinitionen (Schalter/Dimmer) mit Nanoleaf-Verknüpfung |
| `nanoleaf.json` | Nanoleaf-Gerätecache mit IP-Adresse und API-Token |

> **Sicherheitshinweis:** Der Nanoleaf API-Token wird im Klartext in `nanoleaf.json` gespeichert. Der Zugriff auf das `/data`-Verzeichnis ist durch die Container-Isolierung der HCU geschützt.

---

## Lizenz

Siehe [LICENSE](./LICENSE).  
Copyright © 2026 Kevin Schipper
