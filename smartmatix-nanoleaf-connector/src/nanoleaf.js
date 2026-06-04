'use strict';

/**
 * nanoleaf.js – Kommunikation mit der Nanoleaf REST API
 *
 * Unterstützte Endpunkte (Nanoleaf Matter WiFi Essentials Open API):
 *   GET  /api/v1/<token>/           – Geräteinformationen + aktueller Zustand
 *   GET  /api/v1/<token>/state/on   – Ein/Aus-Zustand
 *   PUT  /api/v1/<token>/state      – Zustand setzen (on, brightness, hue, sat, ct)
 *
 * Discovery:
 *   Subnet-Scan auf das LAN-Subnetz der HCU (TCP-Connect-Test auf Port 16021).
 *   mDNS funktioniert in Container-Netzwerken nicht zuverlässig (NAT-bridged).
 *   Zusätzlich kann manuell eine IP-Adresse eingegeben werden.
 *
 * Nicht unterstützt (bewusst ausgelassen):
 *   - Effects/Scenes (Homematic IP App unterstützt keine Effekte)
 *   - Stream Control / LED-Einzelansteuerung
 *
 * Ressourceneffizienz:
 *   - Kein Polling; Zustände werden nur bei CONTROL_REQUEST und beim
 *     Verbindungsaufbau abgefragt.
 *   - HTTP-Anfragen erfolgen sequenziell (kein paralleles Flood-Firing).
 *   - Timeouts verhindern hängende Verbindungen zu offline-Geräten.
 */

const http         = require('http');
const dns          = require('dns').promises;
const devicesStore = require('./devicesStore');
const log          = require('./logger');

// ---------------------------------------------------------------------------
//  Konstanten
// ---------------------------------------------------------------------------

const NANOLEAF_API_PORT  = 16021;
const NANOLEAF_API_BASE  = '/api/v1';
const REQUEST_TIMEOUT_MS = 5000;  // 5s pro HTTP-Request

// ---------------------------------------------------------------------------
//  Interner HTTP-Helper
// ---------------------------------------------------------------------------

/**
 * Führt einen HTTP-Request gegen die Nanoleaf REST API aus.
 *
 * @param {string} method    – 'GET' | 'PUT'
 * @param {string} ip        – IP-Adresse des Nanoleaf-Geräts
 * @param {number} port      – API-Port (Standard: 16021)
 * @param {string} apiPath   – z.B. '/api/v1/<token>/state'
 * @param {object|null} body – Request-Body (wird als JSON serialisiert)
 * @returns {Promise<object|null>} – Geparste JSON-Antwort oder null (204 No Content)
 */
function request(method, ip, port, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: ip,
      port:     port ?? NANOLEAF_API_PORT,
      path:     apiPath,
      method,
      timeout:  REQUEST_TIMEOUT_MS,
      headers:  {
        'Content-Type': 'application/json',
      },
    };
    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        log.debug(`Nanoleaf ${method} ${ip}:${port}${apiPath} – HTTP ${res.statusCode}: ${raw.substring(0, 200)}`);

        // 204 No Content – kein Body erwartet
        if (res.statusCode === 204) return resolve(null);

        // Fehlerhafte Statuscodes
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Nanoleaf ${method} ${apiPath} fehlgeschlagen (HTTP ${res.statusCode})`));
        }

        if (!raw.trim()) return resolve(null);

        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Nanoleaf API: Ungueltige JSON-Antwort von ${apiPath}: ${raw.substring(0, 100)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Nanoleaf API Timeout (${REQUEST_TIMEOUT_MS}ms) fuer ${ip}:${port}${apiPath}`));
    });

    req.on('error', (err) => {
      log.debug(`Nanoleaf Netzwerkfehler bei ${method} ${ip}:${port}${apiPath}: ${err.message}`);
      reject(err);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
//  Öffentliche API: Gerätekommunikation
// ---------------------------------------------------------------------------

/**
 * Ruft alle Geräteinformationen und den aktuellen Zustand vom Nanoleaf ab.
 *
 * @param {string} ip        – IP-Adresse
 * @param {number} port      – API-Port
 * @param {string} authToken – Auth-Token
 * @returns {Promise<object|null>} – Geräteobjekt oder null bei Fehler
 */
async function getDeviceInfo(ip, port, authToken) {
  try {
    return await request('GET', ip, port, `${NANOLEAF_API_BASE}/${authToken}/`);
  } catch (err) {
    log.warn(`Nanoleaf getDeviceInfo (${ip}): ${err.message}`);
    return null;
  }
}

/**
 * Setzt den Zustand eines Nanoleaf-Geräts.
 * Alle Parameter sind optional; nur die übergebenen werden gesetzt.
 *
 * Mapping HCU > Nanoleaf API:
 *   switchState.on          > { on: { value: <bool> } }
 *   dimmerState.level       > { brightness: { value: <0–100> } }
 *   colorState.hue          > { hue: { value: <0–360> } }
 *   colorState.saturation   > { sat: { value: <0–100> } }
 *   colorTemperatureState   > { ct: { value: <Kelvin> } }
 *
 * @param {string}  ip        – IP-Adresse
 * @param {number}  port      – API-Port
 * @param {string}  authToken – Auth-Token
 * @param {object}  stateObj  – Nanoleaf-State-Objekt (bereits in API-Format)
 * @returns {Promise<boolean>} – true bei Erfolg
 */
async function setState(ip, port, authToken, stateObj) {
  try {
    await request('PUT', ip, port, `${NANOLEAF_API_BASE}/${authToken}/state`, stateObj);
    log.info(`Nanoleaf setState (${ip}): ${JSON.stringify(stateObj)}`);
    return true;
  } catch (err) {
    log.error(`Nanoleaf setState (${ip}) fehlgeschlagen: ${err.message}`);
    return false;
  }
}

/**
 * Konvertiert HCU-Features (Connect API 1.0.1) in ein Nanoleaf-State-Objekt.
 *
 * Mapping HCU > Nanoleaf API:
 *   switchState.on            > { on: { value: bool } }
 *   dimming.dimLevel (0–1)    > { brightness: { value: 1–100 } }
 *   color.hue (0–360)         > { hue: { value: 0–360 } }
 *   color.saturationLevel (0–1) > { sat: { value: 0–100 } }
 *   colorTemperature.colorTemperature (Kelvin) > { ct: { value: Kelvin } }
 *
 * Spezialfälle:
 *   - Wird gleichzeitig "on: false" und "brightness" gesendet, ignoriert das
 *     Nanoleaf-Gerät den off-Befehl und dimmt nur. Wenn das Gerät ausgeschaltet
 *     werden soll, wird brightness (und weitere State-Felder) deshalb komplett weggelassen.
 *   - dimLevel exakt 0.0 von der HCU bedeutet "Gerät ausschalten" (HCU mappt
 *     den AUS-Slider so) > konvertieren in on: false.
 *
 * @param {Array} features – HCU-Feature-Array aus CONTROL_REQUEST
 * @returns {object} Nanoleaf State-Objekt für PUT /state
 */
function featuresToNanoleafState(features) {
  const state = {};

  // 1. Durchlauf: alle Features sammeln
  for (const f of features) {
    switch (f.type) {
      case 'switchState':
        state.on = { value: Boolean(f.on) };
        break;

      case 'dimming': {
        // HCU: dimLevel 0.0–1.0 > Nanoleaf: brightness 1–100
        // dimLevel == 0 wird unten zu on:false aufgelöst
        const dim = f.dimLevel ?? 1.0;
        if (dim <= 0) {
          // Wenn noch kein explizites switchState gesetzt wurde > ausschalten
          if (state.on === undefined) state.on = { value: false };
        } else {
          state.brightness = { value: Math.min(100, Math.max(1, Math.round(dim * 100))) };
        }
        break;
      }

      case 'color': {
        // HCU: hue 0–360, saturationLevel 0.0–1.0 > Nanoleaf: hue 0–360, sat 0–100
        if (f.hue !== undefined) {
          state.hue = { value: Math.min(360, Math.max(0, Math.round(f.hue))) };
        }
        if (f.saturationLevel !== undefined) {
          state.sat = { value: Math.min(100, Math.max(0, Math.round(f.saturationLevel * 100))) };
        }
        break;
      }

      case 'colorTemperature': {
        // HCU: colorTemperature in Kelvin
        if (f.colorTemperature !== undefined) {
          state.ct = { value: Math.round(f.colorTemperature) };
        }
        break;
      }

      default:
        log.debug(`featuresToNanoleafState: Unbekannter Feature-Typ "${f.type}" > wird ignoriert.`);
    }
  }

  // Spezialfälle: Bei on:false ALLE anderen Felder weglassen.
  // Sonst dimmt Nanoleaf nur auf den brightness-Wert herunter statt auszuschalten.
  if (state.on?.value === false) {
    return { on: { value: false } };
  }

  return state;
}

/**
 * Liest den aktuellen Zustand vom Nanoleaf und konvertiert ihn in HCU-Features
 * (Connect API 1.0.1 konforme Typen und Feldnamen).
 *
 * @param {string} ip        – IP-Adresse
 * @param {number} port      – API-Port
 * @param {string} authToken – Auth-Token
 * @returns {Promise<Array|null>} – HCU-Feature-Array oder null bei Fehler
 */
async function getStateAsFeatures(ip, port, authToken) {
  const info = await getDeviceInfo(ip, port, authToken);
  if (!info?.state) return null;

  const s        = info.state;
  const features = [];

  if (s.on !== undefined) {
    features.push({ type: 'switchState', on: Boolean(s.on.value) });
  }

  if (s.brightness !== undefined) {
    // Nanoleaf: brightness 1–100 > HCU: dimLevel 0.0–1.0
    features.push({ type: 'dimming', dimLevel: (s.brightness.value ?? 100) / 100 });
  }

  if (s.hue !== undefined || s.sat !== undefined) {
    // Nanoleaf: hue 0–360, sat 0–100 > HCU: hue 0–360, saturationLevel 0.0–1.0
    features.push({
      type:           'color',
      hue:            s.hue?.value ?? 0,
      saturationLevel: (s.sat?.value ?? 0) / 100,
    });
  }

  if (s.ct !== undefined) {
    // WICHTIG! Nanoleaf liefert nicht nur den aktuellen Wert, sondern auch die
    // gerätespezifischen Grenzen mit (min/max in Kelvin) > müssen
    // bei JEDEM Status-Update mitgesendet werden, sonst skaliert die
    // HCU-App den Wert gegen falsche Default-Grenzen und zeigt eine
    // falsche Farbtemperatur an.
    features.push({
      type:                     'colorTemperature',
      colorTemperature:         s.ct.value ?? 4000,
      minimalColorTemperature:  s.ct.min   ?? 1200,
      maximumColorTemperature:  s.ct.max   ?? 6500,
    });
  }

  return features.length > 0 ? features : null;
}

// ---------------------------------------------------------------------------
//  Subnet-Scan (Discovery via TCP-Connect-Test)
// ---------------------------------------------------------------------------

/**
 * Scannt das LAN-Subnetz nach Nanoleaf-Geräten durch parallele TCP-Connect-
 * Tests auf Port 16021.
 *
 * @param {object}   opts
 * @param {string}   opts.hcuHost – Hostname/IP der HCU (z.B. 'host.containers.internal').
 *                                  Daraus wird das LAN-Subnetz abgeleitet.
 * @param {Function} opts.onFound – Callback: ({ip, port}) => void bei jedem Treffer
 * @param {Function} opts.onDone  – Callback: (foundCount) => void am Ende
 * @param {string}   [opts.subnet] – Optional: expliziter /24-Prefix (z.B. "192.168.1")
 * @returns {{ stop: Function }}
 */
function startSubnetScan({ hcuHost, onFound, onDone, subnet }) {
  const net = require('net');
  const SCAN_PORT       = NANOLEAF_API_PORT;
  const CONNECT_TIMEOUT = 1500;
  const MAX_PARALLEL    = 32;

  let stopped    = false;
  const foundIps = new Set();

  /**
   * Ermittelt das /24-LAN-Subnetz anhand der HCU-Adresse.
   * Die HCU liegt im selben LAN wie die Nanoleaf-Geräte.
   *
   * @param {string} host – Hostname oder IP
   * @returns {Promise<string|null>} – z.B. '192.168.1' oder null bei Fehler
   */
  async function detectLanSubnet(host) {
    if (subnet) return subnet;

    // Wenn host bereits eine IPv4-Adresse ist, direkt verwenden
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return host.split('.').slice(0, 3).join('.');
    }

    // Sonst per DNS auflösen
    try {
      const result = await dns.lookup(host, { family: 4 });
      const ip = result.address;
      log.info(`Subnet-Scan: HCU-Adresse aufgeloest: ${host} -> ${ip}`);
      return ip.split('.').slice(0, 3).join('.');
    } catch (err) {
      log.warn(`Subnet-Scan: DNS-Lookup fuer ${host} fehlgeschlagen: ${err.message}`);
      return null;
    }
  }

  function isPortOpen(ip) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(CONNECT_TIMEOUT);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error',   () => finish(false));
      try {
        socket.connect(SCAN_PORT, ip);
      } catch {
        finish(false);
      }
    });
  }

  async function worker(queue) {
    while (queue.length > 0 && !stopped) {
      const ip = queue.shift();
      if (!ip) break;

      const open = await isPortOpen(ip);
      if (!open || stopped) continue;

      log.info(`Subnet-Scan: Port ${SCAN_PORT} offen auf ${ip} > moeglicherweise Nanoleaf-Geraet.`);
      foundIps.add(ip);
      if (typeof onFound === 'function') {
        onFound({ ip, port: SCAN_PORT });
      }
    }
  }

  // Asynchron starten: erst LAN-Subnetz auflösen, dann scannen
  detectLanSubnet(hcuHost).then((subnetPrefix) => {
    if (stopped) return;

    if (!subnetPrefix) {
      log.warn('Subnet-Scan: Konnte LAN-Subnetz nicht ermitteln > Scan wird uebersprungen.');
      if (typeof onDone === 'function') onDone(0);
      return;
    }

    log.info(`Subnet-Scan: Starte Suche im Bereich ${subnetPrefix}.1 - ${subnetPrefix}.254 ...`);

    const queue = [];
    for (let i = 1; i <= 254; i++) {
      queue.push(`${subnetPrefix}.${i}`);
    }

    const workers = [];
    for (let i = 0; i < MAX_PARALLEL; i++) {
      workers.push(worker(queue));
    }

    Promise.all(workers).then(() => {
      if (stopped) return;
      log.info(`Subnet-Scan abgeschlossen. ${foundIps.size} potenzielle Nanoleaf-Geraet(e) gefunden.`);
      if (typeof onDone === 'function') onDone(foundIps.size);
    });
  });

  return {
    stop: () => {
      stopped = true;
      log.info('Subnet-Scan: Vorzeitig abgebrochen.');
    },
  };
}


/**
 * Versucht ein Nanoleaf-Gerät über eine manuelle IP-Adresse zu erreichen
 * und liest seine Informationen aus.
 *
 * @param {string} ip        – IP-Adresse des Geräts
 * @param {string} authToken – Auth-Token
 * @param {number} [port]    – API-Port (Standard: 16021)
 * @returns {Promise<object|null>} – Geräteinformationen oder null
 */
async function probeDevice(ip, authToken, port = NANOLEAF_API_PORT) {
  if (!authToken) {
    log.warn(`probeDevice: Kein Auth-Token fuer ${ip} – Gerät kann nicht abgefragt werden.`);
    return null;
  }
  return await getDeviceInfo(ip, port, authToken);
}

/**
 * Fordert einen neuen Auth-Token vom Nanoleaf-Gerät an.
 *
 * Das Gerät muss sich im Kopplungsmodus befinden (Power-Taste 5-7 Sekunden
 * gedrückt halten bis die LEDs aufleuchten). Der Token wird dann per
 * POST /api/v1/new angefordert.
 *
 * @param {string} ip     – IP-Adresse des Geräts
 * @param {number} [port] – API-Port (Standard: 16021)
 * @returns {Promise<string|null>} – Auth-Token oder null bei Fehler
 */
async function requestAuthToken(ip, port = NANOLEAF_API_PORT) {
  try {
    log.info(`Nanoleaf: Fordere Auth-Token von ${ip}:${port} an ...`);
    const result = await request('POST', ip, port, '/api/v1/new');
    const token  = result?.auth_token ?? null;
    if (token) {
      log.info(`Nanoleaf: Auth-Token erfolgreich erhalten von ${ip}.`);
    } else {
      log.warn(`Nanoleaf: Keine auth_token-Eigenschaft in Antwort von ${ip}.`);
    }
    return token;
  } catch (err) {
    // HTTP 403 = Gerät nicht im Kopplungsmodus
    if (err.message?.includes('403')) {
      log.warn(`Nanoleaf: ${ip} ist nicht im Kopplungsmodus (HTTP 403). Taste 5-7s halten.`);
    } else {
      log.warn(`Nanoleaf: Auth-Token-Anfrage fehlgeschlagen (${ip}): ${err.message}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Persistenz-Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Liest die nanoleaf.json und gibt das Array zurück.
 * @returns {Array}
 */
function loadNanoleafDevices() {
  return devicesStore.loadNanoleafDevices();
}

/**
 * Aktualisiert einen Eintrag in der nanoleaf.json anhand der id (serialNo).
 * @param {object} updatedDevice – Nanoleaf-Geräteobjekt mit .id
 */
function updateNanoleafDevice(updatedDevice) {
  const devices = loadNanoleafDevices();
  const idx     = devices.findIndex(d => d.id === updatedDevice.id);
  if (idx >= 0) {
    devices[idx] = updatedDevice;
    log.info(`Nanoleaf: Geraet ${updatedDevice.id} in nanoleaf.json aktualisiert.`);
  } else {
    devices.push(updatedDevice);
    log.info(`Nanoleaf: Geraet ${updatedDevice.id} in nanoleaf.json neu eingetragen.`);
  }
  devicesStore.saveNanoleafDevices(devices);
}

/**
 * Entfernt einen Eintrag aus der nanoleaf.json anhand der id (serialNo).
 * @param {string} nanoleafId
 */
function removeNanoleafDevice(nanoleafId) {
  const devices  = loadNanoleafDevices();
  const filtered = devices.filter(d => d.id !== nanoleafId);
  devicesStore.saveNanoleafDevices(filtered);
  log.info(`Nanoleaf: Gerät ${nanoleafId} aus nanoleaf.json entfernt.`);
}

module.exports = {
  getDeviceInfo,
  setState,
  featuresToNanoleafState,
  getStateAsFeatures,
  startSubnetScan,
  probeDevice,
  requestAuthToken,
  loadNanoleafDevices,
  updateNanoleafDevice,
  removeNanoleafDevice,
  NANOLEAF_API_PORT,
};
