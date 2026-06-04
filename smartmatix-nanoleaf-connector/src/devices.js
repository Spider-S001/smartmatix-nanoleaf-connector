'use strict';

/**
 * devices.js – Geräteverwaltung
 *
 * Hier werden die LIGHT-Geräte verwaltet, die dieses Plugin
 * gegenüber der HCU (Connect API 1.0.1) repräsentiert.
 *
 * Jedes Nanoleaf-Gerät wird als ein LIGHT-Gerät in der HCU angelegt.
 *
 * Gerätestruktur (Connect API 1.0.1):
 * {
 *   deviceType:      'LIGHT'
 *   deviceId:        'nanoleaf-light-ab12cd34'
 *   firmwareVersion: '3.0.10'
 *   friendlyName:    'Nanoleaf Essentials'
 *   modelType:       'NanoleafLight'
 *   features: [
 *     { type: 'switchState', on: false },
 *     { type: 'dimmerState', level: 100 },
 *     { type: 'colorState',  hue: 0, saturation: 0, value: 100 },
 *     { type: 'colorTemperatureState', colorTemperature: 4000 }
 *   ]
 *   nanoleafId:      'V24250ND0003D'   // serialNo des Nanoleaf-Geräts
 *   alreadyIncluded: false
 * }
 */

const log         = require('./logger');
const devicesStore = require('./devicesStore');
const { v4: uuidv4 } = require('uuid');
const { DEVICE_FEATURES } = require('../constants/device_constants.js');

// In-Memory-Registry: Map<deviceId, deviceObject>
let deviceRegistry = loadStoredDevices();

// ---------------------------------------------------------------------------
//  Interne Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Lädt Geräte aus der devices.json und gibt sie als Map zurück. */
function loadStoredDevices() {
  const stored = devicesStore.load('devices');
  const map    = new Map(Object.entries(stored));
  log.info(`${map.size} Geraet(e) aus devices.json geladen.`);
  return map;
}

// ---------------------------------------------------------------------------
//  Öffentliche API
// ---------------------------------------------------------------------------

/** Gibt alle registrierten Geräte als Array zurück (für DISCOVER_RESPONSE). */
function getAll() {
  return Array.from(deviceRegistry.values());
}

/** Gibt ein einzelnes Gerät nach ID zurück (für STATUS_RESPONSE). */
function getById(deviceId) {
  return deviceRegistry.get(deviceId) ?? null;
}

/** Gibt die Anzahl der Geräte zurück. */
function getDevicesLength() {
  return deviceRegistry.size;
}

/**
 * Verarbeitet den Steuerbefehl der HCU (CONTROL_REQUEST).
 * Aktualisiert die In-Memory-Registry; die Übermittlung an das Nanoleaf-
 * Gerät erfolgt asynchron in plugin.js nach diesem Aufruf.
 *
 * @param {string}   deviceId – Ziel-Geräte-ID
 * @param {object[]} features – Array von Feature-Objekten mit neuem Zustand
 * @returns {boolean} true = Befehl erfolgreich verarbeitet
 */
function control(deviceId, features) {
  const device = deviceRegistry.get(deviceId);
  if (!device) {
    log.warn(`control(): Geraet nicht gefunden: ${deviceId}`);
    return false;
  }

  if (!Array.isArray(features) || features.length === 0) {
    log.warn(`control(): Keine Features im CONTROL_REQUEST fuer ${deviceId}`);
    return false;
  }

  for (const incoming of features) {
    const existing = device.features.find(f => f.type === incoming.type);
    if (existing) {
      Object.assign(existing, incoming);
      log.info(`${deviceId} | Feature "${incoming.type}" aktualisiert:`, JSON.stringify(incoming));
    } else {
      log.warn(`${deviceId}: Unbekannter Feature-Typ "${incoming.type}" > wird ignoriert.`);
    }
  }

  return true;
}

/** Lädt die deviceRegistry neu aus der devices.json. */
function reload() {
  deviceRegistry = loadStoredDevices();
  log.info('Geraeteliste neu geladen.');
}

/**
 * Erstellt ein neues LIGHT-Gerät für ein Nanoleaf-Gerät.
 *
 * @param {string} friendlyName  – Anzeigename (Name des Nanoleaf-Geräts)
 * @param {string} nanoleafId    – serialNo des Nanoleaf-Geräts
 * @param {string} firmware      – Firmware-Version des Nanoleaf-Geräts
 * @param {number} [ctMin]       – Minimale Farbtemperatur in Kelvin
 * @param {number} [ctMax]       – Maximale Farbtemperatur in Kelvin
 * @returns {object} Neues Geräteobjekt
 */
function createDevice(friendlyName, nanoleafId, firmware = '1.0.0', ctMin = 1200, ctMax = 6500) {
  const deviceId = `nanoleaf-light-${uuidv4().substring(0, 8)}`;

  // Standard-Features aus device_constants kopieren
  const features = JSON.parse(JSON.stringify(DEVICE_FEATURES['LIGHT']?.features ?? []));

  // Farbtemperatur-Feature mit gerätespezifischen Grenzen
  const ctFeature = features.find(f => f.type === 'colorTemperature');
  if (ctFeature) {
    ctFeature.colorTemperature         = Math.round((ctMin + ctMax) / 2);
    ctFeature.minimalColorTemperature  = ctMin;
    ctFeature.maximumColorTemperature  = ctMax;
  }

  return {
    deviceType:      'LIGHT',
    deviceId,
    firmwareVersion: firmware,
    friendlyName,
    modelType:       'NanoleafLight',
    features,
    nanoleafId,      // Verknüpfung zum Nanoleaf-Gerät (serialNo)
    alreadyIncluded: false,
  };
}

/**
 * Bereinigt einen String von kaputten Encoding-Zeichen (HCU-Bug Workaround).
 * @param {*} value
 * @returns {*}
 */
function sanitize(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\uFFFD/g, '?');
}

module.exports = { getAll, getById, getDevicesLength, control, reload, createDevice, sanitize };
