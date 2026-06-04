'use strict';

/**
 * devicesStore.js
 *
 * Liest und schreibt die Geräte-Konfiguration aus/in eine devices.json
 * sowie Nanoleaf-Gerätedaten aus/in eine nanoleaf.json.
 * Die Dateien liegen im Arbeitsverzeichnis des Plugins: /data
 *
 * Format der devices.json:
 * {
 *   "nanoleaf-light-ab12cd34": {
 *     "deviceType":      "LIGHT",
 *     "deviceId":        "nanoleaf-light-ab12cd34",
 *     "firmwareVersion": "1.0.0",
 *     "friendlyName":    "Mein Nanoleaf",
 *     "modelType":       "NanoleafLight",
 *     "features": [
 *       { "type": "switchState", "on": false },
 *       { "type": "dimmerState", "level": 100 },
 *       { "type": "colorState",  "hue": 0, "saturation": 0, "value": 100 },
 *       { "type": "colorTemperatureState", "colorTemperature": 4000 }
 *     ],
 *     "nanoleafId":  "V24250ND0003D",
 *     "alreadyIncluded": false
 *   }
 * }
 *
 * Format der nanoleaf.json:
 * [
 *   {
 *     "id":           "V24250ND0003D",   // serialNo als eindeutige ID
 *     "name":         "Nanoleaf IMLS 2E7",
 *     "ip":           "192.168.1.100",
 *     "port":         16021,
 *     "authToken":    "ppGL6lMTx6bjC3Lri3VLWyNDEh8olxk5",
 *     "model":        "NL72K1",
 *     "firmware":     "3.0.10",
 *     "deviceId":     "nanoleaf-light-ab12cd34",  // HCU-Gerät
 *     "addToHcu":     false,
 *     "ctMin":        1200,
 *     "ctMax":        6500
 *   }
 * ]
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const DATA_PATH = fs.existsSync('/data')
  ? '/data'
  : path.join(__dirname, '..', 'data');

const allowedTypes = ['devices', 'nanoleaf'];

const DEFAULT_DEVICES = {};

/**
 * Gibt den absoluten Dateipfad für einen erlaubten Typ zurück.
 * @param {string} type – 'devices' | 'nanoleaf'
 * @returns {string|null}
 */
function checkAllowedDeviceType(type) {
  if (allowedTypes.includes(type)) {
    return path.join(DATA_PATH, type + '.json');
  }
  log.warn(`devicesStore: Unbekannter Typ "${type}" – erlaubt sind: ${allowedTypes.join(', ')}.`);
  return null;
}

/**
 * Liest eine JSON-Datei vom Dateisystem.
 * @param {string} type – 'devices' | 'nanoleaf'
 * @returns {object|Array} Gespeichertes Objekt/Array oder {} / []
 */
function load(type) {
  const filePath = checkAllowedDeviceType(type);
  if (!filePath) return type === 'nanoleaf' ? [] : { ...DEFAULT_DEVICES };

  try {
    const raw  = fs.readFileSync(filePath, { encoding: 'utf8' });
    const data = JSON.parse(raw);
    log.info(`${Array.isArray(data) ? data.length : Object.keys(data).length} Eintraege geladen aus: ${filePath}`);
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.info(`Keine ${type}.json gefunden > lege leere Datei an.`);
      const empty = type === 'nanoleaf' ? [] : { ...DEFAULT_DEVICES };
      save(type, empty);
      return empty;
    }
    log.warn(`Fehler beim Lesen der ${type}.json:`, err.message);
    return type === 'nanoleaf' ? [] : { ...DEFAULT_DEVICES };
  }
}

/**
 * Schreibt Daten als JSON in die Datei des angegebenen Typs.
 * @param {string}       type – 'devices' | 'nanoleaf'
 * @param {object|Array} data – Zu schreibende Daten
 */
function save(type, data) {
  const filePath = checkAllowedDeviceType(type);
  if (!filePath) {
    log.error('devicesStore.save: Fehler beim Schreiben > ungueltiger Typ.');
    return;
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf8' });
    log.info(`Konfiguration gespeichert in: ${filePath}`);
  } catch (err) {
    log.error(`Fehler beim Schreiben der ${type}.json:`, err.message);
  }
}

/**
 * Aktualisiert einen einzelnen Eintrag in der devices.json.
 * @param {string} type         – 'devices'
 * @param {string} deviceId     – Schlüssel des zu aktualisierenden Eintrags
 * @param {object} deviceObject – Neuer Wert
 */
function update(type, deviceId, deviceObject) {
  if (type === 'nanoleaf') {
    log.warn('devicesStore.update: Fuer nanoleaf bitte saveNanoleafDevices() nutzen.');
    return;
  }
  const filePath = checkAllowedDeviceType(type);
  if (!filePath) {
    log.error('devicesStore.update: Fehler beim Aktualisieren: ungueltiger Typ.');
    return;
  }
  const current = load(type);
  current[deviceId] = deviceObject;
  save(type, current);

  log.info(`Gespeicherte Konfiguration von ${deviceId}: ${deviceObject}`);
}

/**
 * Entfernt einen einzelnen Eintrag aus der devices.json.
 * @param {string} type     – 'devices'
 * @param {string} deviceId – Schlüssel des zu löschenden Eintrags
 */
function remove(type, deviceId) {
  const filePath = checkAllowedDeviceType(type);
  if (!filePath) {
    log.error('devicesStore.remove: Fehler beim Entfernen: ungueltiger Typ.');
    return;
  }
  const current = load(type);
  delete current[deviceId];
  save(type, current);
}

/**
 * Markiert Geräte in der devices.json als bereits an die HCU übermittelt.
 * @param {string[]} deviceIds – Array von Geräte-IDs
 */
function markAsIncluded(deviceIds) {
  const current = load('devices');
  deviceIds.forEach(id => {
    if (current[id]) current[id].alreadyIncluded = true;
  });
  save('devices', current);
}

/**
 * Liest die nanoleaf.json und gibt das Array zurück.
 * @returns {Array}
 */
function loadNanoleafDevices() {
  return load('nanoleaf');
}

/**
 * Schreibt das gesamte Nanoleaf-Geräte-Array in nanoleaf.json.
 * @param {Array} devices
 */
function saveNanoleafDevices(devices) {
  save('nanoleaf', devices);
  log.info(`Nanoleaf-Geraete gespeichert: ${devices}`);
}

module.exports = { load, save, update, remove, markAsIncluded, loadNanoleafDevices, saveNanoleafDevices };
