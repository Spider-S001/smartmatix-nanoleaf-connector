'use strict';

/**
 * plugin.js – Kernklasse des SmartMatix Nanoleaf Connectors
 *
 * Verwaltet:
 *   • WebSocket-Verbindung zur HCU (inkl. Exponential-Backoff-Reconnect)
 *   • Authentifizierung per Header (authtoken + plugin-id)
 *   • Protokoll-Handshake gemäß Connect API 1.0.1
 *   • Routing eingehender Nachrichten an Handler-Methoden
 *   • Steuerung von Nanoleaf LIGHT-Geräten über die REST API
 *   • Discovery neuer Nanoleaf-Geräte (Netzwerkscan + manuelle IP)
 *
 * Verbindungsablauf (Connect API 1.0.1):
 *   1. WebSocket-Verbindung aufbauen (Header: authtoken, plugin-id)
 *   2. Bei „open": sofort PLUGIN_STATE_RESPONSE { READY } senden
 *   3. Auf PLUGIN_STATE_REQUEST  > erneut PLUGIN_STATE_RESPONSE { READY }
 *   4. Auf DISCOVER_REQUEST      > DISCOVER_RESPONSE mit Geräteliste
 *   5. Auf CONTROL_REQUEST       > Nanoleaf steuern + CONTROL_RESPONSE
 *   6. Auf CONFIG_TEMPLATE_REQUEST > Einstellungsseite generieren
 *   7. Auf CONFIG_UPDATE_REQUEST > Neue Einstellungen verarbeiten
 *
 * Polling:
 *   Das Plugin fragt in einem konfigurierbaren Intervall (Standard: 60 s,
 *   Minimum: 10 s) den Zustand aller Nanoleaf-Geräte ab. Ändert sich ein
 *   Wert gegenüber dem zuletzt bekannten Zustand, wird ein STATUS_EVENT an
 *   die HCU gesendet und der neue Zustand in der devices.json persistiert.
 *   Beim Verbindungsaufbau (_onOpen) wird der echte Zustand von allen
 *   Geräten abgefragt, bevor STATUS_EVENTs gesendet werden.
 */

const WebSocket      = require('ws');
const { v4: uuidv4 } = require('uuid');
const log            = require('./logger');
const devices        = require('./devices');
const configStore    = require('./configStore');
const devicesStore   = require('./devicesStore');
const nanoleaf       = require('./nanoleaf.js');
const { t }          = require('./localization');
const { createNotifier }    = require('./notifications');
const { HcuPluginUpdater }  = require('./hcu-plugin-updater');
const backup                = require('./backup-plugin-data');

// ---------------------------------------------------------------------------
//  Reconnect-Einstellungen
// ---------------------------------------------------------------------------
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 60_000;
const RECONNECT_FACTOR  = 1.5;

// Feste Message-IDs (für self-replacing notifications)
const MSG_ID_API_UNAVAILABLE = 'nanoleaf-api-unavailable';
const MSG_ID_SCAN_RUNNING    = 'nanoleaf-scan-running';
const MSG_ID_SCAN_DONE       = 'nanoleaf-scan-done';
const MSG_ID_TOKEN_PAIR      = 'nanoleaf-token-pair';


class Plugin {
  /**
   * @param {object} opts
   * @param {string} opts.pluginId  – Eindeutige Plugin-ID
   * @param {string} opts.host      – Hostname/IP der HCU
   * @param {string} opts.authtoken – Aktivierungsschlüssel aus der HCU
   */
  constructor({ pluginId, host, authtoken }) {
    this.pluginId  = pluginId;
    this.host      = host;
    this.authtoken = authtoken;

    this._config = configStore.load();
    log.info(`Geraete reinkludieren: ${this._config.reincludeDevices ? 'aktiv' : 'inaktiv'}`);

    this._devices = devices.getAll();
    log.info(`${this._devices.length} Geraet(e) aus devices.json geladen.`);

    this._ws             = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._stopping       = false;
    this._lang           = 'de'; // Wird aus CONFIG_TEMPLATE_REQUEST aktualisiert

    // Polling
    this._pollTimer    = null;
    this._pollInterval = Math.max(10, this._config.pollInterval ?? 60);

    // _pendingDiscovery bleibt für eventuelle Remote-Nutzung erhalten
    this._pendingDiscovery = [];
    this._isScanning       = false;
    this._scanEndsAt       = null;
    this._scanHandle       = null;
    this._scanUpdateTimer  = null;

    // Notifier – wird nach _connect() über _send gespeist
    this._notify   = null;
    this._updater  = null;
    this._backupManager = backup.create();
    try {
      const _sgtin = require('fs').readFileSync('/SGTIN', 'utf8').trim();
      this._backupHost = `hcu1-${_sgtin.slice(-4)}.local`;
    } catch {
      this._backupHost = 'localhost';
    }
  }

  // ---------------------------------------------------------------------------
  //  Öffentliche API
  // ---------------------------------------------------------------------------

  start() {
    this._stopping = false;
    this._connect();
  }

  stop() {
    log.info('Plugin wird beendet...');
    this._stopping = true;
    this._clearReconnect();
    this._stopPolling();
    this._stopScan();
    // Stop Update Scheduler
    this._updater?.stopSchedule();
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  //  WebSocket-Lifecycle
  // ---------------------------------------------------------------------------

  _connect() {
    const url = `wss://${this.host}:9001`;
    log.info(`Verbinde zu ${url} ...`);

    this._ws = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout:   30_000,   // 30s > HCU braucht manchmal länger beim Start
      headers: {
        'authtoken': this.authtoken,
        'plugin-id': this.pluginId,
      },
    });

    this._ws.on('open',    ()              => this._onOpen());
    this._ws.on('message', (data)          => this._onMessage(data));
    this._ws.on('error',   (err)           => this._onError(err));
    this._ws.on('close',   (code, reason)  => this._onClose(code, reason));
  }

  _onOpen() {
    log.info('WebSocket verbunden.');
    this._reconnectDelay = RECONNECT_BASE_MS;

    // Notifier nach Verbindungsaufbau initialisieren
    this._notify = createNotifier(this.pluginId, (msg) => this._send(msg), t);

    // Update-Checker starten (täglich, sofort beim ersten Verbindungsaufbau)
    if (!this._updater) {
      this._updater = new HcuPluginUpdater(this._ws, this.pluginId);
      this._updater.startSchedule('https://github.com/SmartMatix/smartmatix-nanoleaf-connector', 'SmartMatix Nanoleaf Connector');
    }

    // Pflicht beim Verbindungsaufbau: Plugin als READY melden
    this._sendPluginReady(uuidv4());

    // Zuerst echte Zustände von allen Nanoleaf-Geräten holen,
    // dann STATUS_EVENTs an die HCU senden
    this._fetchAllAndSendStatusEvents().catch(err => {
      log.warn('_onOpen: Fehler beim Zustandsabruf:', err.message);
      // Fallback
      this._sendAllStatusEvents();
    });

    // Polling starten
    this._startPolling();
  }

  _onMessage(raw) {
    let message;
    try {
      const decoded = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
      message = JSON.parse(decoded);
    } catch {
      log.warn('Ungueltige JSON-Nachricht empfangen:', raw.toString());
      return;
    }

    log.debug('< HCU:', JSON.stringify(message, null, 2));

    switch (message.type) {
      case 'PLUGIN_STATE_REQUEST':
        // HCU fragt regelmäßig nach dem Plugin-Status
        this._sendPluginReady(message.id);
        break;
      case 'DISCOVER_REQUEST':
        // HCU möchte wissen, welche Geräte das Plugin verwaltet
        this._handleDiscoverRequest(message);
        break;
      case 'CONTROL_REQUEST':
        // HCU möchte ein Gerät steuern
        this._handleControlRequest(message);
        break;
      case 'STATUS_REQUEST':
        // HCU fragt den aktuellen Gerätestatus ab
        this._handleStatusRequest(message);
        break;
      case 'CONFIG_TEMPLATE_REQUEST':
        // HCU fragt nach konfigurierbaren Einstellungen des Plugins
        try { this._handleConfigTemplateRequest(message); }
        catch (e) { log.error('CONFIG_TEMPLATE_REQUEST handler error:', e.message, e.stack); }
        break;
      case 'CONFIG_UPDATE_REQUEST':
        // Benutzer hat Konfiguration in der HCU-Oberfläche gespeichert
        try { this._handleConfigUpdateRequest(message); }
        catch (e) { log.error('CONFIG_UPDATE_REQUEST handler error:', e.message, e.stack); }
        break;
      default:
        log.debug(`Unbekannter Nachrichtentyp: "${message.type}"`);
    }
  }

  _onError(err) {
    log.error('WebSocket-Fehler:', err.code ?? '', err.message ?? err);
  }

  _onClose(code, reason) {
    const r = reason ? reason.toString() : '>';
    log.warn(`WebSocket getrennt (Code: ${code}, Grund: ${r})`);
    this._stopPolling();
    if (!this._stopping) this._scheduleReconnect();
  }

  // ---------------------------------------------------------------------------
  //  Ausgehende Nachrichten
  // ---------------------------------------------------------------------------

  _send(message) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      log.warn('_send() aufgerufen, aber WebSocket ist nicht offen.');
      return;
    }
    const payload = JSON.stringify(message);
    log.debug('> HCU:', payload);
    this._ws.send(payload);
  }

  /**
   * PLUGIN_STATE_RESPONSE – teilt der HCU mit, dass das Plugin betriebsbereit ist.
   * Muss beim Verbindungsaufbau und auf jeden PLUGIN_STATE_REQUEST gesendet werden.
   */
  _sendPluginReady(messageId) {
    const message = {
      id:       messageId,
      pluginId: this.pluginId,
      type:     'PLUGIN_STATE_RESPONSE',
      body: {
        pluginReadinessStatus: 'READY',
      },
    };
    log.info('Sende PLUGIN_STATE_RESPONSE { READY }');
    this._send(message);
  }

  // ---------------------------------------------------------------------------
  //  Request-Handler
  // ---------------------------------------------------------------------------

  /**
   * DISCOVER_REQUEST > DISCOVER_RESPONSE
   * Die HCU fragt, welche Geräte das Plugin verwaltet.
   */
  _handleDiscoverRequest(message) {
    log.info('DISCOVER_REQUEST empfangen > sende Geraeteliste.');
    this._sendDiscoverResponse(message.id);
  }

  /**
   * CONTROL_REQUEST > Nanoleaf steuern > CONTROL_RESPONSE
   * Die HCU möchte den Zustand eines Geräts ändern.
   */
  _handleControlRequest(message) {
    const { deviceId, features } = message.body ?? {};
    log.info(`CONTROL_REQUEST fuer Geraet: ${deviceId}`, features);

    const success = devices.control(deviceId, features);

    if (success) {
      // Aktualisierten Zustand in devices.json persistieren
      const updatedDevice = devices.getById(deviceId);
      if (updatedDevice) {
        devicesStore.update('devices', deviceId, updatedDevice);

        // Asynchron an Nanoleaf-Gerät senden – CONTROL_RESPONSE nicht blockieren
        this._sendToNanoleaf(updatedDevice, features).catch(err => {
          log.error(`Nanoleaf-Steuerung fuer ${deviceId} fehlgeschlagen: ${err.message}`);
        });
      }
    }

    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONTROL_RESPONSE',
      body: {
        deviceId,
        success,
      },
    };
    this._send(response);
  }

  /**
   * Überträgt HCU-Features an das zugehörige Nanoleaf-Gerät.
   * Schlägt lautlos fehl wenn kein Nanoleaf-Gerät gefunden wird.
   *
   * @param {object}  hcuDevice – HCU-Geräteobjekt (enthält .nanoleafId)
   * @param {Array}   features  – HCU-Feature-Array aus CONTROL_REQUEST
   */
  async _sendToNanoleaf(hcuDevice, features) {
    const nanoleafDevices = nanoleaf.loadNanoleafDevices();
    const nl = nanoleafDevices.find(d => d.id === hcuDevice.nanoleafId);

    if (!nl) {
      log.warn(`_sendToNanoleaf: Kein Nanoleaf-Eintrag fuer nanoleafId "${hcuDevice.nanoleafId}".`);
      return;
    }

    if (!nl.authToken) {
      log.warn(`_sendToNanoleaf: Kein Auth-Token fuer Nanoleaf "${nl.name}" (${nl.ip}).`);
      return;
    }

    const stateObj = nanoleaf.featuresToNanoleafState(features);

    if (Object.keys(stateObj).length === 0) {
      log.debug(`_sendToNanoleaf: Keine uebertragbaren States fuer ${nl.ip}.`);
      return;
    }

    await nanoleaf.setState(nl.ip, nl.port, nl.authToken, stateObj);
  }

  /**
   * STATUS_REQUEST > aktuellen Gerätestatus liefern.
   * Liest den Zustand direkt vom Nanoleaf-Gerät, wenn verfügbar.
   */
  _handleStatusRequest(message) {
    const { deviceId } = message.body ?? {};
    log.info(`STATUS_REQUEST fuer Geraet: ${deviceId}`);

    const device  = devices.getById(deviceId);
    const success = device != null;

    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'STATUS_RESPONSE',
      body: {
        success,
        devices: success ? [device] : [],
      },
    };
    this._send(response);

    // Aktuellen Zustand vom Nanoleaf nachladen und als STATUS_EVENT senden
    if (success && device.nanoleafId) {
      this._refreshNanoleafState(device).catch(err => {
        log.debug(`STATUS_REQUEST Nanoleaf-Refresh fehlgeschlagen: ${err.message}`);
      });
    }
  }

  /**
   * CONFIG_TEMPLATE_REQUEST → Konfigurationsvorlage liefern
   *
   * Gibt die Einstellungsseite zurück mit:
   *   - Allgemeine Einstellungen (Netzwerkscan, manuelle IP)
   *   - Liste bekannter Nanoleaf-Geräte (aus nanoleaf.json) mit Löschen-Option
   *   - Liste entdeckter, noch nicht hinzugefügter Geräte (pendingDiscovery)
   *   - Reinkludierungs-Option
   *   - Informationen/Links
   */
  _handleConfigTemplateRequest(message) {
    log.info('CONFIG_TEMPLATE_REQUEST empfangen > sende Konfigurationsvorlage.');

    if (message.body?.language) {
      this._lang = message.body.language;
      log.debug(`Localization: Sprache aus CONFIG_TEMPLATE_REQUEST: ${this._lang}`);
    }

    // Verwaiste deviceId-Verweise bereinigen (nach Plugin-Neuinstallation)
    const nanoleafDevices = this._loadAndCleanNanoleafDevices();

    this._send({
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONFIG_TEMPLATE_RESPONSE',
      body: {
        groups:     this._generateSettingsGroups(nanoleafDevices),
        properties: this._defineVariableFields(nanoleafDevices),
      },
    });
  }

  /**
   * CONFIG_UPDATE_REQUEST > neue Konfiguration entgegennehmen.
   *
   * Verarbeitet:
   *   - scanNow: Netzwerkscan starten
   *   - manualIp + manualAuthToken: manuell Gerät hinzufügen
   *   - nanoleaf_${num}_add: entdecktes Gerät zur HCU hinzufügen
   *   - nanoleaf_${num}_delete: Gerät aus HCU und nanoleaf.json entfernen
   *   - reincludeDevices: Reinkludierungs-Flag
   */
  _handleConfigUpdateRequest(message) {
    const { properties } = message.body ?? {};
    log.info('CONFIG_UPDATE_REQUEST empfangen');

    // --- Backup / Restore ---
    // Felder backupMode / restoreMode aus dem properties-Objekt extrahieren
    // und an den backupManager weitergeben.
    // Die HCU schickt Felder mit Präfix (z.B. 'backup_data_backupMode').
    // Der backupManager erwartet normalisierte Felder ('backupMode', 'restoreMode').
    const backupFields = {};
    if (properties?.backup_data_backupMode  === true || properties?.backup_data_backupMode  === 'true') backupFields.backupMode  = true;
    if (properties?.restore_data_restoreMode === true || properties?.restore_data_restoreMode === 'true') backupFields.restoreMode = true;
    if (this._backupManager.handleConfigUpdate(backupFields)) {
      // Update wurde vom Backup-Manager verarbeitet – Einstellungsseite neu pushen
      // und Antwort sofort senden (kein weiterer Handler nötig).
      this._pushConfigTemplate();
      this._send({
        id:       message.id,
        pluginId: this.pluginId,
        type:     'CONFIG_UPDATE_RESPONSE',
        body: { status: 'APPLIED' },
      });
      return;
    }

    let devicesChanged = false;

    // --- Reinkludierung ---
    const reincludeDevices = properties?.reincludeDevices;
    if (reincludeDevices !== undefined) {
      this._config.reincludeDevices = reincludeDevices === true || reincludeDevices === 'true';
      configStore.save(this._config);
    }

    // --- Poll-Intervall ---
    const pollIntervalRaw = properties?.pollInterval;
    if (pollIntervalRaw !== undefined) {
      const parsed = this._pollIntervalFromDisplay(String(pollIntervalRaw));
      if (parsed >= 10) {
        this._pollInterval        = parsed;
        this._config.pollInterval = parsed;
        configStore.save(this._config);
        this._stopPolling();
        this._startPolling();
        log.info(`Poll-Intervall geaendert auf ${parsed}s.`);
      }
    }

    // --- Manuelle IP + Auth-Token ---
    const manualIp        = (properties?.manualIp ?? '').trim();
    const manualAuthToken = (properties?.manualAuthToken ?? '').trim();
    const manualPort      = parseInt(properties?.manualPort, 10) || nanoleaf.NANOLEAF_API_PORT;
    const requestToken    = properties?.manualRequestToken === true || properties?.manualRequestToken === 'true';

    if (manualIp) {
      if (requestToken) {
        nanoleaf.requestAuthToken(manualIp, manualPort)
          .then(async (token) => {
            if (!token) {
              this._notify?.localized(
                'notification.pairing.failed.title',
                'notification.pairing.failed.message',
                { ip: manualIp },
                'ERROR',
                { id: MSG_ID_TOKEN_PAIR },
              );
              this._pushConfigTemplate();
              return;
            }
            this._notify?.dismiss(MSG_ID_TOKEN_PAIR);
            const added = await this._addManualDevice(manualIp, manualPort, token);
            if (added) {
              devices.reload();
              this._triggerRediscover();
            }
            this._pushConfigTemplate();
          })
          .catch(err => log.error('Token-Anfrage fehlgeschlagen:', err.message));
      } else if (manualAuthToken) {
        this._addManualDevice(manualIp, manualPort, manualAuthToken)
          .then((added) => {
            if (added) {
              devices.reload();
              this._triggerRediscover();
            }
            this._pushConfigTemplate();
          })
          .catch(err => log.error('Manuelle Geraetezufügung fehlgeschlagen:', err.message));
      }
    }

    // --- Netzwerkscan starten ---
    const scanNow = properties?.scanNow === true || properties?.scanNow === 'true';
    if (scanNow && !this._isScanning) {
      this._startScan();
    }

    // --- Entdeckte Geräte hinzufügen (pendingDiscovery) ---
    const pending = this._pendingDiscovery;
    pending.forEach((candidate, i) => {
      const num    = i + 1;
      const addKey = `pending_${num}_add`;
      const tokKey = `pending_${num}_token`;
      const shouldAdd   = properties?.[addKey] === true || properties?.[addKey] === 'true';
      const token       = (properties?.[tokKey] ?? candidate.authToken ?? '').trim();

      if (shouldAdd && token) {
        this._addManualDevice(candidate.ip, candidate.port, token, candidate.name)
          .then((added) => {
            if (added) {
              this._pendingDiscovery = this._pendingDiscovery.filter(p => p.ip !== candidate.ip);
              devices.reload();
              this._triggerRediscover();
              this._pushConfigTemplate();
            }
          })
          .catch(err => log.error(`Fehler beim Hinzufuegen von ${candidate.ip}:`, err.message));
      }
    });

    // --- Bekannte Nanoleaf-Geräte löschen ---
    const nanoleafDevices = nanoleaf.loadNanoleafDevices();
    nanoleafDevices.forEach((nl, i) => {
      const num       = i + 1;
      const deleteKey = `nanoleaf_${num}_delete`;
      const shouldDelete = properties?.[deleteKey] === true || properties?.[deleteKey] === 'true';

      if (shouldDelete) {
        log.info(`Nanoleaf: Loesche Geraet ${nl.id} (${nl.name}) auf Benutzeranfrage.`);
        if (nl.deviceId) {
          devicesStore.remove('devices', nl.deviceId);
          log.info(`HCU-Geraet ${nl.deviceId} aus devices.json entfernt.`);
          devicesChanged = true;
        }
        nanoleaf.removeNanoleafDevice(nl.id);
      }
    });

    if (devicesChanged) {
      devices.reload();
      this._triggerRediscover();
    }

    // Einstellungsseite aktualisieren
    devices.reload();
    this._pushConfigTemplate();

    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONFIG_UPDATE_RESPONSE',
      body: {
        status: 'APPLIED',
      },
    };
    this._send(response);
  }

  // ---------------------------------------------------------------------------
  //  Nanoleaf-Gerät manuell/via Discovery hinzufügen
  // ---------------------------------------------------------------------------

  /**
   * Verbindet sich mit einem Nanoleaf-Gerät, liest seine Informationen aus
   * und legt ein HCU-LIGHT-Gerät an.
   *
   * @param {string} ip        – IP-Adresse
   * @param {number} port      – API-Port
   * @param {string} authToken – Auth-Token
   * @param {string} [hint]    – Optionaler Name-Hinweis (aus Netzwerkscan)
   * @returns {Promise<boolean>} – true wenn Gerät erfolgreich hinzugefügt
   */
  async _addManualDevice(ip, port, authToken, hint = '') {
    log.info(`Nanoleaf: Verbinde mit Gerät ${ip}:${port} ...`);

    const info = await nanoleaf.probeDevice(ip, authToken, port);

    if (!info) {
      log.warn(`Nanoleaf: Geraet ${ip} nicht erreichbar oder Auth-Token ungueltig.`);
      this._sendApiUnavailableNotification(ip);
      return false;
    }

    this._deleteApiUnavailableNotification();

    const serialNo       = info.serialNo ?? `${ip}-${Date.now()}`;
    const deviceName     = info.name     ?? hint ?? `Nanoleaf @ ${ip}`;
    const firmware       = info.firmwareVersion ?? '1.0.0';
    const model          = info.model    ?? 'Nanoleaf';
    const ctMin          = info.state?.ct?.min ?? 1200;
    const ctMax          = info.state?.ct?.max ?? 6500;

    // Bereits bekannte Geräte nicht doppelt anlegen
    const existing = nanoleaf.loadNanoleafDevices().find(d => d.id === serialNo);
    if (existing) {
      log.info(`Nanoleaf: Gerät ${serialNo} (${deviceName}) ist bereits bekannt.`);
      // Auth-Token aktualisieren falls geändert
      if (existing.authToken !== authToken) {
        existing.authToken = authToken;
        nanoleaf.updateNanoleafDevice(existing);
        log.info(`Nanoleaf: Auth-Token fuer ${serialNo} aktualisiert.`);
      }
      return false;
    }

    // HCU-LIGHT-Gerät erstellen
    const hcuDevice = devices.createDevice(deviceName, serialNo, firmware, ctMin, ctMax);
    devicesStore.update('devices', hcuDevice.deviceId, hcuDevice);
    log.info(`Nanoleaf: HCU-LIGHT-Geraet erstellt: ${hcuDevice.deviceId} für ${deviceName}`);

    // Nanoleaf-Eintrag in nanoleaf.json persistieren
    const nlEntry = {
      id:        serialNo,
      name:      deviceName,
      ip,
      port:      port ?? nanoleaf.NANOLEAF_API_PORT,
      authToken,
      model,
      firmware,
      deviceId:  hcuDevice.deviceId,
      ctMin,
      ctMax,
    };
    nanoleaf.updateNanoleafDevice(nlEntry);

    log.info(`Nanoleaf: Gerät "${deviceName}" (${serialNo}) erfolgreich hinzugefuegt.`);
    return true;
  }

  // ---------------------------------------------------------------------------
  //  DISCOVER-Trigger und DISCOVER_RESPONSE
  // ---------------------------------------------------------------------------

  /**
   * Triggert einen neuen DISCOVER_REQUEST von der HCU.
   * Nur nötig wenn nach einem asynchronen Vorgang (z.B. manuelles Hinzufügen)
   * die HCU über neue Geräte informiert werden soll.
   */
  _triggerRediscover() {
    log.info('Triggere DISCOVER_REQUEST via PLUGIN_STATE_RESPONSE READY ...');
    this._sendPluginReady(uuidv4());
  }

  /**
   * Sendet eine DISCOVER_RESPONSE an die HCU.
   *   - Alle nicht-inkludierten Geräte werden gesendet (oder alle wenn reincludeDevices)
   *   - markAsIncluded wird immer sofort gesetzt
   *   - Funktioniert sowohl auf echte DISCOVER_REQUESTs als auch unaufgefordert
   *
   * @param {string|null} [messageId] – Message-ID aus DISCOVER_REQUEST (null = unaufgefordert)
   */
  _sendDiscoverResponse(messageId = null) {
    const id         = messageId ?? uuidv4();
    const allDevices = devices.getAll();

    const toReport = this._config.reincludeDevices
      ? allDevices
      : allDevices.filter(d => !d.alreadyIncluded);

    this._send({
      id,
      pluginId: this.pluginId,
      type:     'DISCOVER_RESPONSE',
      body: {
        success: true,
        devices: toReport,
      },
    });

    devicesStore.markAsIncluded(toReport.map(d => d.deviceId));
    devices.reload();
    log.info(`DISCOVER_RESPONSE gesendet mit ${toReport.length} Geraet(en).`);
  }

  // ---------------------------------------------------------------------------
  //  Einstellungsseite (CONFIG_TEMPLATE)
  // ---------------------------------------------------------------------------

  /**
   * Generiert alle Einstellungsgruppen.
   * @param {Array} nanoleafDevices – Geräte aus nanoleaf.json
   * @returns {object} Gruppenobjekt
   */
  _generateSettingsGroups(nanoleafDevices) {
    const lang   = this._lang;
    const groups = {
      general: {
        friendlyName: t(lang, 'group.general.name'),
        description:  t(lang, 'group.general.description'),
        order:        1,
      },
      discovery_auto: {
        friendlyName: t(lang, 'group.discovery.auto.name'),
        description:  t(lang, 'group.discovery.auto.description'),
        order:        2,
      },
      discovery_manual: {
        friendlyName: t(lang, 'group.discovery.manual.name'),
        description:  t(lang, 'group.discovery.manual.description'),
        order:        3,
      },
    };

    // Gruppen für bekannte Nanoleaf-Geräte (aus nanoleaf.json)
    nanoleafDevices.forEach((nl, i) => {
      const num = i + 1;
      groups[`nanoleaf_${num}`] = {
        friendlyName: nl.name,
        description:  t(lang, 'group.device.description').replace('{model}', nl.model ?? ''),
        order:        10 + i,
      };
    });

    // Gruppen für entdeckte, noch nicht hinzugefügte Geräte
    this._pendingDiscovery.forEach((candidate, i) => {
      const num = i + 1;
      groups[`pending_${num}`] = {
        friendlyName: candidate.name ?? `Nanoleaf @ ${candidate.ip}`,
        description:  t(lang, 'group.pending.description').replace('{ip}', candidate.ip),
        order:        100 + i,
      };
    });

    // --- Backup & Restore ---
    const backupConfigGroups = this._backupManager.getConfigGroups();
    const backupHost = this._backupHost;
    const safeLang = lang || 'de';
    const resolveDesc = (desc) => {
      const raw = (typeof desc === 'object' ? desc?.[lang] : desc) ?? '';
      return raw
        .replace(/\{\{hostname\}\}/g, backupHost)
        .replace(/\{\{lang\}\}/g, lang ?? 'en');
    };
    groups.backup_data = {
      friendlyName: backupConfigGroups[0].label?.[safeLang] ?? '',
      description:  resolveDesc(backupConfigGroups[0].description),
      order:        997,
    };
    groups.restore_data = {
      friendlyName: backupConfigGroups[1].label?.[safeLang] ?? '',
      description:  resolveDesc(backupConfigGroups[1].description),
      order:        998,
    };

    // --- Plugin-Infos ---
    groups.info = {
      friendlyName: t(lang, 'group.info.name'),
      description:  t(lang, 'group.info.description'),
      order:        999,
    };

    return groups;
  }

  /**
   * Erstellt alle konfigurierbaren Einstellungsfelder.
   * @param {Array} nanoleafDevices – Geräte aus nanoleaf.json
   * @returns {object} Properties-Objekt für CONFIG_TEMPLATE_RESPONSE
   */
  _defineVariableFields(nanoleafDevices) {
    this._config = configStore.load();
    const lang   = this._lang;
    const scanLabel       = this._formatScanCountdown(lang);
    const scanDescription = this._isScanning
      ? t(lang, 'settings.scan.description.running')
      : t(lang, 'settings.scan.description');

    const properties = {
      // --- Allgemein ---
      reincludeDevices: {
        friendlyName: t(lang, 'settings.reinclude.label'),
        description:  t(lang, 'settings.reinclude.description'),
        dataType:     'BOOLEAN',
        groupId:      'general',
        order:        1,
        defaultValue: false,
        currentValue: this._config.reincludeDevices ?? false,
      },

      pollInterval: {
        friendlyName: t(lang, 'settings.pollinterval.label'),
        description:  t(lang, 'settings.pollinterval.description'),
        dataType:     'ENUM',
        groupId:      'general',
        order:        2,
        defaultValue: t(lang, 'settings.pollinterval.60s'),
        currentValue: t(lang, `settings.pollinterval.${this._pollIntervalKey()}`),
        values: [
          t(lang, 'settings.pollinterval.10s'),
          t(lang, 'settings.pollinterval.30s'),
          t(lang, 'settings.pollinterval.60s'),
          t(lang, 'settings.pollinterval.5min'),
          t(lang, 'settings.pollinterval.15min'),
          t(lang, 'settings.pollinterval.30min'),
          t(lang, 'settings.pollinterval.1h'),
        ],
      },

      // --- Tab "Geräte automatisch hinzufügen" ---
      scanNow: {
        friendlyName: this._formatScanCountdown(lang),
        description:  this._isScanning
          ? t(lang, 'settings.scan.description.running')
          : t(lang, 'settings.scan.description'),
        dataType:     'BOOLEAN',
        groupId:      'discovery_auto',
        order:        1,
        defaultValue: false,
        currentValue: false,
      },

      // --- Tab "Geräte manuell hinzufügen" (Fallback) ---
      manualIp: {
        friendlyName: t(lang, 'settings.manualip.label'),
        description:  t(lang, 'settings.manualip.description'),
        dataType:     'STRING',
        groupId:      'discovery_manual',
        order:        1,
        defaultValue: '',
        currentValue: '',
      },
      manualPort: {
        friendlyName: t(lang, 'settings.manualport.label'),
        description:  t(lang, 'settings.manualport.description'),
        dataType:     'STRING',
        groupId:      'discovery_manual',
        order:        2,
        defaultValue: String(nanoleaf.NANOLEAF_API_PORT),
        currentValue: String(nanoleaf.NANOLEAF_API_PORT),
      },
      manualRequestToken: {
        friendlyName: t(lang, 'settings.manualauthtoken.request.label'),
        description:  t(lang, 'settings.manualauthtoken.request.description'),
        dataType:     'BOOLEAN',
        groupId:      'discovery_manual',
        order:        3,
        defaultValue: true,
        currentValue: true,
      },
      manualAuthToken: {
        friendlyName: t(lang, 'settings.manualauthtoken.label'),
        description:  t(lang, 'settings.manualauthtoken.description'),
        dataType:     'PASSWORD',
        groupId:      'discovery_manual',
        order:        4,
        defaultValue: '',
        currentValue: '',
      },
    };

    // --- Bekannte Nanoleaf-Geräte ---
    nanoleafDevices.forEach((nl, i) => {
      const num       = i + 1;
      const groupId   = `nanoleaf_${num}`;
      const orderBase = i * 10;

      properties[`nanoleaf_${num}_ip`] = {
        friendlyName: t(lang, 'device.ip.label'),
        description:  t(lang, 'device.ip.description'),
        dataType:     'READONLY',
        groupId,
        order:        orderBase + 1,
        currentValue: nl.ip,
      };

      properties[`nanoleaf_${num}_model`] = {
        friendlyName: t(lang, 'device.model.label'),
        description:  t(lang, 'device.model.description'),
        dataType:     'READONLY',
        groupId,
        order:        orderBase + 2,
        currentValue: `${nl.model ?? '–'} (FW ${nl.firmware ?? '–'})`,
      };

      properties[`nanoleaf_${num}_deviceid`] = {
        friendlyName: t(lang, 'device.hcuid.label'),
        description:  t(lang, 'device.hcuid.description'),
        dataType:     'READONLY',
        groupId,
        order:        orderBase + 3,
        currentValue: nl.deviceId ?? t(lang, 'device.hcuid.none'),
      };

      properties[`nanoleaf_${num}_delete`] = {
        friendlyName: t(lang, 'device.delete.label'),
        description:  t(lang, 'device.delete.description'),
        dataType:     'BOOLEAN',
        groupId,
        order:        orderBase + 4,
        defaultValue: false,
        currentValue: false,
      };
    });

    // --- Entdeckte, noch nicht hinzugefügte Geräte ---
    this._pendingDiscovery.forEach((candidate, i) => {
      const num     = i + 1;
      const groupId = `pending_${num}`;

      properties[`pending_${num}_ip`] = {
        friendlyName: t(lang, 'device.ip.label'),
        description:  t(lang, 'device.ip.description'),
        dataType:     'READONLY',
        groupId,
        order:        1,
        currentValue: `${candidate.ip}:${candidate.port}`,
      };

      properties[`pending_${num}_token`] = {
        friendlyName: t(lang, 'settings.manualauthtoken.label'),
        description:  t(lang, 'settings.pending.token.description'),
        dataType:     'PASSWORD',
        groupId,
        order:        2,
        defaultValue: '',
        currentValue: '',
      };

      properties[`pending_${num}_add`] = {
        friendlyName: t(lang, 'device.add.label'),
        description:  t(lang, 'device.add.description'),
        dataType:     'BOOLEAN',
        groupId,
        order:        3,
        defaultValue: false,
        currentValue: false,
      };
    });

    // --- Backup & Restore ---
    // LABEL-Felder werden als description der Gruppe gerendert (kein eigenes Property).
    const backupConfigGroups = this._backupManager.getConfigGroups();
    const backupHost = this._backupHost;

    const safeLang = lang || 'de';
    const mapBackupField = (field, i, groupId) => {
      if (field.type === 'LABEL') return;
      if (field.type === 'LINK') {
        const resolvedUrl = (field.url ?? '')
          .replace('{{hostname}}', backupHost)
          .replace('{{lang}}', safeLang);
        properties[`${groupId}_${field.id}`] = {
          friendlyName: field.buttonLabel?.[safeLang] ?? field.label?.[safeLang] ?? '',
          description:  field.label?.[safeLang] ?? '',
          dataType:     'WEBLINK',
          groupId,
          order:        i + 1,
          defaultValue: field.buttonLabel?.[safeLang] ?? field.label?.[safeLang] ?? '',
          currentValue: resolvedUrl,
        };
        return;
      }
      const resolvedValue = field.readOnly
        ? (field.value ?? '').replace('{{hostname}}', backupHost).replace('{{lang}}', lang ?? 'en')
        : (field.value ?? false);
      properties[`${groupId}_${field.id}`] = {
        friendlyName: field.label?.[safeLang] ?? '',
        description:  '',
        dataType:     field.type === 'BOOLEAN' ? 'BOOLEAN' : 'STRING',
        groupId,
        order:        i + 1,
        defaultValue: resolvedValue,
        currentValue: resolvedValue,
        ...(field.readOnly ? { readOnly: true } : {}),
      };
    };
    backupConfigGroups[0].fields.forEach((f, i) => mapBackupField(f, i, 'backup_data'));
    backupConfigGroups[1].fields.forEach((f, i) => mapBackupField(f, i, 'restore_data'));

    // --- Info ---
    properties.copyrightInfo = {
      friendlyName: t(lang, 'settings.copyrightinfo.label'),
      description:  t(lang, 'settings.copyrightinfo.description'),
      dataType:     'WEBLINK',
      groupId:      'info',
      order:        1,
      defaultValue: t(lang, 'settings.copyrightinfo.linktitle'),
      currentValue: 'https://nanoleaf.me/',
    };
    properties.pluginInfo = {
      friendlyName: t(lang, 'settings.pluginInfo.label'),
      description:  t(lang, 'settings.pluginInfo.description'),
      dataType:     'WEBLINK',
      groupId:      'info',
      order:        2,
      defaultValue: t(lang, 'settings.pluginInfo.linktitle'),
      currentValue: 'https://github.com/Spider-S001/smartmatix-nanoleaf-connector',
    };

    return properties;
  }

  // ---------------------------------------------------------------------------
  //  Status-Events beim Verbindungsaufbau
  // ---------------------------------------------------------------------------

  /**
   * Fallback: Überträgt die in devices.json gespeicherten Zustände an die HCU.
   * Wird nur aufgerufen wenn _fetchAllAndSendStatusEvents() fehlschlägt.
   */
  _sendAllStatusEvents() {
    const allDevices = devices.getAll();
    allDevices.forEach(device => {
      this._send({
        id:       uuidv4(),
        pluginId: this.pluginId,
        type:     'STATUS_EVENT',
        body: {
          deviceId: device.deviceId,
          features: device.features,
        },
      });
    });
    log.info(`${allDevices.length} persistierte(r) Geraetezustand(e) an HCU uebertragen (Fallback).`);
  }

  /**
   * Beim Verbindungsaufbau: echten Zustand aller Nanoleaf-Geräte abfragen,
   * in devices.json persistieren und als STATUS_EVENTs an die HCU senden.
   * Geräte die nicht erreichbar sind, senden den gespeicherten Zustand.
   */
  async _fetchAllAndSendStatusEvents() {
    const allDevices      = devices.getAll();
    const nanoleafDevices = nanoleaf.loadNanoleafDevices();

    for (const hcuDevice of allDevices) {
      const nl = nanoleafDevices.find(d => d.id === hcuDevice.nanoleafId);

      let featuresToSend = hcuDevice.features; // Fallback: persistierter Zustand

      if (nl?.authToken) {
        const liveFeatures = await nanoleaf.getStateAsFeatures(nl.ip, nl.port, nl.authToken);
        if (liveFeatures) {
          featuresToSend = liveFeatures;
          // Persistieren
          this._mergeAndPersist(hcuDevice, liveFeatures);
          log.info(`_fetchAllAndSendStatusEvents: Echter Zustand von ${nl.name} (${nl.ip}) geladen.`);
        } else {
          log.warn(`_fetchAllAndSendStatusEvents: ${nl.name} (${nl.ip}) nicht erreichbar > sende persistierten Zustand.`);
        }
      }

      this._send({
        id:       uuidv4(),
        pluginId: this.pluginId,
        type:     'STATUS_EVENT',
        body:     { deviceId: hcuDevice.deviceId, features: featuresToSend },
      });
    }

    log.info(`_fetchAllAndSendStatusEvents: ${allDevices.length} Geraet(e) verarbeitet.`);
  }

  // ---------------------------------------------------------------------------
  //  Polling
  // ---------------------------------------------------------------------------

  /**
   * Startet den Polling-Timer. Bestehende Timer werden vorher gestoppt.
   * Intervall: this._pollInterval Sekunden (Minimum 10 s).
   */
  _startPolling() {
    this._stopPolling();
    if (this._pollInterval <= 0) {
      log.info('Polling deaktiviert (Intervall = 0).');
      return;
    }
    const intervalMs = this._pollInterval * 1000;
    log.info(`Polling gestartet: alle ${this._pollInterval}s.`);
    this._pollTimer = setInterval(() => this._pollAllDevices(), intervalMs);
  }

  /** Stoppt den Polling-Timer. */
  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      log.debug('Polling gestoppt.');
    }
  }

  /**
   * Fragt alle bekannten Nanoleaf-Geräte sequenziell ab.
   * Sendet nur dann ein STATUS_EVENT wenn sich mindestens ein Wert geändert
   * hat.
   * Geänderte Werte werden zusätzlich in devices.json persistiert.
   */
  async _pollAllDevices() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const allDevices      = devices.getAll();
    const nanoleafDevices = nanoleaf.loadNanoleafDevices();

    for (const hcuDevice of allDevices) {
      const nl = nanoleafDevices.find(d => d.id === hcuDevice.nanoleafId);
      if (!nl?.authToken) continue;

      let liveFeatures;
      try {
        liveFeatures = await nanoleaf.getStateAsFeatures(nl.ip, nl.port, nl.authToken);
      } catch (err) {
        log.debug(`Poll: ${nl.name} (${nl.ip}) nicht erreichbar: ${err.message}`);
        continue;
      }

      if (!liveFeatures) continue;

      // Änderungen gegenüber gespeichertem Zustand ermitteln
      const changed = this._detectChanges(hcuDevice.features, liveFeatures);
      if (!changed) {
        log.debug(`Poll: Kein Statuswechsel bei ${nl.name}.`);
        continue;
      }

      log.info(`Poll: Statusaenderung erkannt bei ${nl.name} (${nl.ip}) – sende STATUS_EVENT.`);

      // In-Memory + Datei aktualisieren
      this._mergeAndPersist(hcuDevice, liveFeatures);

      this._send({
        id:       uuidv4(),
        pluginId: this.pluginId,
        type:     'STATUS_EVENT',
        body:     { deviceId: hcuDevice.deviceId, features: liveFeatures },
      });
    }
  }

  /**
   * Vergleicht zwei Feature-Arrays und gibt true zurück wenn sich
   * mindestens ein relevanter Wert geändert hat.
   *
   * @param {Array} stored – Zuletzt bekannte Features aus devices.json
   * @param {Array} live   – Aktuell vom Gerät gelesene Features
   * @returns {boolean}
   */
  _detectChanges(stored, live) {
    for (const liveFeature of live) {
      const storedFeature = stored.find(f => f.type === liveFeature.type);
      if (!storedFeature) return true; // Neues Feature-Feld

      switch (liveFeature.type) {
        case 'switchState':
          if (storedFeature.on !== liveFeature.on) return true;
          break;
        case 'dimming':
          if (storedFeature.dimLevel !== liveFeature.dimLevel) return true;
          break;
        case 'color':
          if (storedFeature.hue             !== liveFeature.hue ||
              storedFeature.saturationLevel !== liveFeature.saturationLevel) return true;
          break;
        case 'colorTemperature':
          if (storedFeature.colorTemperature !== liveFeature.colorTemperature) return true;
          break;
      }
    }
    return false;
  }

  /**
   * Überschreibt die In-Memory-Features eines HCU-Geräts mit den
   * Live-Werten und persistiert das Gerät sofort in devices.json.
   *
   * @param {object} hcuDevice    – HCU-Geräteobjekt (wird in-place geändert)
   * @param {Array}  liveFeatures – Aktuell vom Gerät gelesene Features
   */
  _mergeAndPersist(hcuDevice, liveFeatures) {
    for (const incoming of liveFeatures) {
      const existing = hcuDevice.features.find(f => f.type === incoming.type);
      if (existing) {
        Object.assign(existing, incoming);
      }
    }
    devicesStore.update('devices', hcuDevice.deviceId, hcuDevice);
  }

  /**
   * Liest den aktuellen Zustand eines Nanoleaf-Geräts und sendet ihn als STATUS_EVENT.
   * Persistiert den Zustand in devices.json.
   * Wird bei STATUS_REQUEST aufgerufen.
   * @param {object} hcuDevice – HCU-Geräteobjekt
   */
  async _refreshNanoleafState(hcuDevice) {
    const nanoleafDevices = nanoleaf.loadNanoleafDevices();
    const nl = nanoleafDevices.find(d => d.id === hcuDevice.nanoleafId);
    if (!nl?.authToken) return;

    const features = await nanoleaf.getStateAsFeatures(nl.ip, nl.port, nl.authToken);
    if (!features) return;

    // Persistieren und In-Memory aktualisieren
    const device = devices.getById(hcuDevice.deviceId);
    if (device) this._mergeAndPersist(device, features);

    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'STATUS_EVENT',
      body:     { deviceId: hcuDevice.deviceId, features },
    });
  }

  // ---------------------------------------------------------------------------
  //  Proaktive Einstellungsseiten-Aktualisierung
  // ---------------------------------------------------------------------------

  /**
   * Sendet eine unaufgeforderte CONFIG_TEMPLATE_RESPONSE an die HCU.
   * Lädt nanoleaf.json einmalig und bereinigt verwaiste deviceId-Verweise.
   */
  _pushConfigTemplate() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const nanoleafDevices = this._loadAndCleanNanoleafDevices();
    this._sendConfigTemplateNow(nanoleafDevices);
  }

  /**
   * Sendet CONFIG_TEMPLATE_RESPONSE mit den bereits geladenen Geräten.
   * Kein Disk-I/O – wird vom Countdown-Timer aufgerufen.
   * @param {Array} nanoleafDevices
   */
  _sendConfigTemplateNow(nanoleafDevices) {
    log.info('Nanoleaf: Sende proaktive CONFIG_TEMPLATE_RESPONSE.');
    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'CONFIG_TEMPLATE_RESPONSE',
      body: {
        groups:     this._generateSettingsGroups(nanoleafDevices),
        properties: this._defineVariableFields(nanoleafDevices),
      },
    });
  }

  /**
   * Lädt nanoleaf.json und bereinigt verwaiste deviceId-Verweise.
   * @returns {Array}
   */
  _loadAndCleanNanoleafDevices() {
    return nanoleaf.loadNanoleafDevices().map(nl => {
      if (nl.deviceId && !devices.getById(nl.deviceId)) {
        log.info(`Nanoleaf: deviceId ${nl.deviceId} nicht mehr in devices.json > wird zurueckgesetzt (${nl.id}).`);
        nl.deviceId = null;
        nanoleaf.updateNanoleafDevice(nl);
      }
      return nl;
    });
  }

  // ---------------------------------------------------------------------------
  //  HCU-Benachrichtigungen (via notifications.js)
  // ---------------------------------------------------------------------------

  _sendApiUnavailableNotification(ip = '') {
    const suffix = ip ? ` (${ip})` : '';
    log.warn(`Nanoleaf: Gerät nicht erreichbar${suffix}.`);
    this._notify?.localized(
      'notification.api.unavailable.title',
      'notification.api.unavailable.message',
      { suffix },
      'ERROR',
      { id: MSG_ID_API_UNAVAILABLE },
    );
  }

  _deleteApiUnavailableNotification() {
    this._notify?.dismiss(MSG_ID_API_UNAVAILABLE);
  }

  // ---------------------------------------------------------------------------
  //  Netzwerkscan (5-Minuten-Discovery-Modus)
  // ---------------------------------------------------------------------------

  /**
   * Startet den 5-Minuten-Netzwerkscan-Modus.
   *
   * - PTR-Queries werden alle 30 s wiederholt (Geräte können jederzeit in den
   *   Kopplungsmodus versetzt werden)
   * - Neue Geräte erscheinen sofort im Config-Template
   * - Alle 10 s wird der Countdown im Config-Template aktualisiert
   * - Nach 5 Min stoppt der Scan automatisch
   */
  _startScan() {
    const SCAN_DURATION_MS    = 5 * 60 * 1000;  // 5 Minuten
    const COUNTDOWN_UPDATE_MS = 10 * 1000;      // Countdown-Refresh alle 10s

    this._isScanning  = true;
    this._scanEndsAt  = new Date(Date.now() + SCAN_DURATION_MS);
    log.info(`Scan gestartet. Laeuft bis: ${this._scanEndsAt.toLocaleTimeString()}`);

    this._notify?.localized(
      'notification.scan.started.title',
      'notification.scan.started.message',
      {},
      'INFO',
      { id: MSG_ID_SCAN_RUNNING, behaviorType: 'DISMISSIBLE' },
    );

    /**
     * Gemeinsamer onFound-Handler für den Subnet-Scan.
     *
     * Workflow für jedes neu entdeckte Gerät:
     *   1. Duplikate filtern (bereits bekannt oder bereits pending)
     *   2. Auto-Token via /api/v1/new versuchen
     *   3. Bei Erfolg: Gerät direkt hinzufügen und an HCU melden
     *   4. Bei Fehler: in pendingDiscovery aufnehmen, damit der Nutzer
     *      den Token manuell eintragen kann
     */
    const handleFound = async (candidate, source) => {
      const knownIps = nanoleaf.loadNanoleafDevices().map(d => d.ip);
      if (knownIps.includes(candidate.ip)) {
        log.debug(`${source}: ${candidate.ip} bereits bekannt > ignoriere.`);
        return;
      }
      const alreadyPending = this._pendingDiscovery.some(p => p.ip === candidate.ip);
      if (alreadyPending) {
        log.debug(`${source}: ${candidate.ip} bereits in pendingDiscovery > ignoriere.`);
        return;
      }

      log.info(`${source}: Neues Geraet entdeckt: ${candidate.ip} > versuche Auth-Token.`);

      // Auto-Token-Versuch
      try {
        const token = await nanoleaf.requestAuthToken(candidate.ip, candidate.port);
        if (token) {
          log.info(`${source}: Auto-Token erhalten fuer ${candidate.ip} > fuege Geraet hinzu.`);
          const added = await this._addManualDevice(
            candidate.ip,
            candidate.port,
            token,
            candidate.name,
          );
          if (added) {
            devices.reload();
            this._triggerRediscover();
            this._pushConfigTemplate();
          }
          return;
        }
        // Kein Token erhalten (z.B. nicht im Kopplungsmodus) > Fallback
        log.info(`${source}: Auto-Token fehlgeschlagen fuer ${candidate.ip} > manuelle Eingabe noetig.`);
      } catch (err) {
        log.warn(`${source}: Fehler beim Auto-Token-Versuch fuer ${candidate.ip}: ${err.message}`);
      }

      // Fallback: in pendingDiscovery aufnehmen, Nutzer trägt Token manuell ein
      this._pendingDiscovery.push({
        ip:   candidate.ip,
        port: candidate.port,
        name: candidate.name ?? `Nanoleaf @ ${candidate.ip}`,
      });
      this._pushConfigTemplate();
    };

    // Subnet-Scan starten – ermittelt automatisch das LAN-Subnetz anhand
    // der HCU-Adresse (DNS-Lookup auf this.host).
    this._scanHandle = nanoleaf.startSubnetScan({
      hcuHost: this.host,
      onFound: (c) => handleFound(c, 'Subnet-Scan'),
      onDone:  (foundCount) => {
        log.info(`Subnet-Scan: ${foundCount} potenzielle Geraete erreichbar.`);
      },
    });

    // Anzahl bereits bekannter Geräte zu Scan-Beginn merken,
    // um am Ende die neu hinzugefügten zählen zu können.
    const knownAtStart = nanoleaf.loadNanoleafDevices().length;

    // Master-Timeout das den Scan nach SCAN_DURATION_MS endgültig beendet
    setTimeout(() => {
      if (!this._isScanning) return;

      // Geräte die direkt automatisch hinzugefügt wurden:
      const knownAtEnd  = nanoleaf.loadNanoleafDevices().length;
      const autoAdded   = Math.max(0, knownAtEnd - knownAtStart);
      // Geräte die manuelle Token-Eingabe brauchen:
      const pendingCount = this._pendingDiscovery.length;

      this._scanHandle?.stop();
      this._isScanning = false;
      this._scanEndsAt = null;
      this._scanHandle = null;
      this._stopScanCountdown();
      log.info(`Scan abgeschlossen: ${autoAdded} Geraet(e) automatisch hinzugefuegt, ${pendingCount} warten auf manuelle Token-Eingabe.`);

      this._notify?.dismiss(MSG_ID_SCAN_RUNNING);

      const opts = { id: MSG_ID_SCAN_DONE };

      if (autoAdded > 0 && pendingCount === 0) {
        // Erfolgsfall: alle Geräte automatisch hinzugefügt
        const msgKey = autoAdded === 1
          ? 'notification.scan.success.message.singular'
          : 'notification.scan.success.message.plural';
        this._notify?.localized(
          'notification.scan.success.title',
          msgKey,
          { count: autoAdded },
          'INFO', opts,
        );

      } else if (autoAdded > 0 && pendingCount > 0) {
        // Teilweise erfolgreich
        const autoKey = autoAdded === 1
          ? 'notification.scan.partial.auto.singular'
          : 'notification.scan.partial.auto.plural';
        const pendKey = pendingCount === 1
          ? 'notification.scan.partial.pending.singular'
          : 'notification.scan.partial.pending.plural';

        const buildMessage = (lang) => {
          const auto    = t(lang, autoKey).replaceAll('{count}', String(autoAdded));
          const pending = t(lang, pendKey).replaceAll('{count}', String(pendingCount));
          return t(lang, 'notification.scan.partial.message')
                   .replaceAll('{auto}',    auto)
                   .replaceAll('{pending}', pending);
        };

        this._notify?.(
          {
            de: t('de', 'notification.scan.partial.title'),
            en: t('en', 'notification.scan.partial.title'),
          },
          { de: buildMessage('de'), en: buildMessage('en') },
          'INFO', opts,
        );

      } else if (pendingCount > 0) {
        // Nur manuelle Token-Eingabe nötig
        const msgKey = pendingCount === 1
          ? 'notification.scan.pending.message.singular'
          : 'notification.scan.pending.message.plural';
        this._notify?.localized(
          'notification.scan.pending.title',
          msgKey,
          { count: pendingCount },
          'INFO', opts,
        );

      } else {
        // Nichts gefunden
        this._notify?.localized(
          'notification.scan.empty.title',
          'notification.scan.empty.message',
          {},
          'INFO', opts,
        );
      }

      this._pushConfigTemplate();
    }, SCAN_DURATION_MS);

    // Countdown alle 10 s aktualisieren
    this._scanUpdateTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      const nanoleafDevices = nanoleaf.loadNanoleafDevices();
      this._sendConfigTemplateNow(nanoleafDevices);
    }, COUNTDOWN_UPDATE_MS);
  }

  /** Stoppt einen laufenden Scan und den Countdown-Timer. */
  _stopScan() {
    this._scanHandle?.stop();
    this._scanHandle  = null;
    this._isScanning  = false;
    this._scanEndsAt  = null;
    this._stopScanCountdown();
  }

  _stopScanCountdown() {
    if (this._scanUpdateTimer) {
      clearInterval(this._scanUpdateTimer);
      this._scanUpdateTimer = null;
    }
  }

  /**
   * Gibt den Lokalisierungs-Suffix für das aktuelle Poll-Intervall zurück.
   * Wird für das ENUM-Feld benötigt (currentValue muss dem Anzeigewert entsprechen).
   * @returns {string} z.B. '60s' | '5min' | '1h'
   */
  _pollIntervalKey() {
    const map = { 10: '10s', 30: '30s', 60: '60s', 300: '5min', 900: '15min', 1800: '30min', 3600: '1h' };
    return map[this._pollInterval] ?? '60s';
  }

  /**
   * Konvertiert einen lesbaren Intervall-String (aus ENUM currentValue) zurück in Sekunden.
   * Versucht zuerst alle bekannten Lokalisierungen, fällt auf parseInt als Fallback zurück.
   * @param {string} displayValue
   * @returns {number} Sekunden
   */
  _pollIntervalFromDisplay(displayValue) {
    const SECONDS_BY_KEY = { '10s': 10, '30s': 30, '60s': 60, '5min': 300, '15min': 900, '30min': 1800, '1h': 3600 };
    for (const [key, secs] of Object.entries(SECONDS_BY_KEY)) {
      for (const lang of ['de', 'en']) {
        if (t(lang, `settings.pollinterval.${key}`) === displayValue) return secs;
      }
    }
    // Fallback: direkte Zahleneingabe
    const parsed = parseInt(displayValue, 10);
    return isNaN(parsed) ? 60 : parsed;
  }

  /**
   * Formatiert die verbleibende Scan-Zeit als lesbaren String.
   * @param {string} lang
   * @returns {string} z.B. "Suche läuft ... noch 4:32 min"
   */
  _formatScanCountdown(lang) {
    if (!this._scanEndsAt) return t(lang, 'settings.scan.label');
    const remaining = Math.max(0, Math.round((this._scanEndsAt - Date.now()) / 1000));
    const m = Math.floor(remaining / 60);
    const s = String(remaining % 60).padStart(2, '0');
    return t(lang, 'settings.scan.running').replace('{remaining}', `${m}:${s}`);
  }

  // ---------------------------------------------------------------------------
  //  Reconnect mit Exponential Backoff
  // ---------------------------------------------------------------------------

  _scheduleReconnect() {
    log.info(`Wiederverbindung in ${this._reconnectDelay / 1000}s ...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this._reconnectDelay);

    this._reconnectDelay = Math.min(
      Math.round(this._reconnectDelay * RECONNECT_FACTOR),
      RECONNECT_MAX_MS,
    );
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

module.exports = Plugin;