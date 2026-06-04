# Basis-Image der HCU (ARM64 – Pflicht für Deployment auf der HCU)
FROM --platform=linux/arm64 ghcr.io/homematicip/alpine-node-simple:0.0.1

WORKDIR /app

# Abhängigkeiten: vorinstallierte node_modules direkt mitkopieren.
# npm install läuft auf dem Build-Rechner (vor docker build),
# nicht im emulierten ARM64-Container via QEMU – das verhindert
# Installationsfehler bei der Cross-Compilation.
COPY package*.json  ./
COPY node_modules/  ./node_modules/

# Quellcode kopieren
COPY src/        ./src/
COPY constants/  ./constants/
COPY lang/       ./lang/

# Einstiegspunkt:
#   Argument 1: Plugin-ID
#   Argument 2: HCU-Host (host.containers.internal = HCU selbst)
#   Argument 3: Pfad zur Auth-Token-Datei (von der HCU bereitgestellt unter /TOKEN)
EXPOSE 8743

ENTRYPOINT ["node", "src/index.js", "de.smartmatix.plugin.nanoleaf-connector", "host.containers.internal", "/TOKEN"]

# ---------------------------------------------------------------------------
#  Plugin-Metadaten (PFLICHT für die HCU – exakt dieses Label-Format)
#
#  pluginId      muss identisch mit der ENTRYPOINT-Plugin-ID sein
#  hcuMinVersion mindestens 1.6.16 für Connect API 1.0.1
#  scope         LOCAL = nur im lokalen Netzwerk
# ---------------------------------------------------------------------------
LABEL de.eq3.hmip.plugin.metadata='\
{\
  "pluginId": "de.smartmatix.plugin.nanoleaf-connector",\
  "issuer": "Kevin Schipper",\
  "version": "1.0.0",\
  "hcuMinVersion": "1.6.16",\
  "scope": "LOCAL",\
  "settings": [],\
  "friendlyName": {\
    "en": "SmartMatix Nanoleaf Connector",\
    "de": "SmartMatix Nanoleaf Connector"\
  },\
  "description": {\
    "en": "A plugin for controlling your Nanoleaf devices via the HCU.",\
    "de": "Ein Plugin, um deine Nanoleaf-Geraete ueber die HCU zu steuern."\
  },\
  "image": "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",\
  "logsEnabled": true\
}'
