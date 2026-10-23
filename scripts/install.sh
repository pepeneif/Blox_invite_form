#!/usr/bin/env bash
# Blox_invite_form — instalador para Linux (systemd) y macOS (launchd).
#
#   sudo ./scripts/install.sh            # instala y arranca el servicio
#   sudo ./scripts/install.sh --uninstall
#
# Instala en /opt/blox-invite-form, crea .env desde .env.example si no existe
# y levanta el servicio en 127.0.0.1:8090 (detras de un proxy inverso).
set -euo pipefail

APP_NAME="blox-invite-form"
APP_DIR="/opt/${APP_NAME}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "==> Desinstalando ${APP_NAME}"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    launchctl unload -w "/Library/LaunchDaemons/com.blox.${APP_NAME}.plist" 2>/dev/null || true
    rm -f "/Library/LaunchDaemons/com.blox.${APP_NAME}.plist"
  else
    systemctl disable --now "${APP_NAME}.service" 2>/dev/null || true
    rm -f "/etc/systemd/system/${APP_NAME}.service"
    systemctl daemon-reload
  fi
  echo "Ficheros en ${APP_DIR} se dejan intactos (borralos a mano si quieres)."
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Este instalador necesita root: usa sudo." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Falta Node.js (>=18). Instalalo y vuelve a intentarlo." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
echo "==> Node: ${NODE_BIN} ($(${NODE_BIN} --version))"

echo "==> Copiando la aplicacion a ${APP_DIR}"
mkdir -p "${APP_DIR}"
cp -R "${SRC_DIR}/server.js" "${SRC_DIR}/package.json" "${SRC_DIR}/public" "${APP_DIR}/"
if [[ -f "${SRC_DIR}/.env.example" ]]; then
  cp "${SRC_DIR}/.env.example" "${APP_DIR}/.env.example"
fi

if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  echo "==> Creado ${APP_DIR}/.env — REVISALO (MAIL_TO, SMTP_*) antes de usarlo en produccion."
else
  echo "==> Se respeta el .env existente en ${APP_DIR}/.env"
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST="/Library/LaunchDaemons/com.blox.${APP_NAME}.plist"
  cat > "${PLIST}" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.blox.${APP_NAME}</string>
  <key>ProgramArguments</key>
  <array><string>${NODE_BIN}</string><string>${APP_DIR}/server.js</string></array>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/${APP_NAME}.log</string>
  <key>StandardErrorPath</key><string>/var/log/${APP_NAME}.err.log</string>
</dict>
</plist>
PLISTEOF
  launchctl unload -w "${PLIST}" 2>/dev/null || true
  launchctl load -w "${PLIST}"
  echo "==> Servicio launchd cargado: com.blox.${APP_NAME}"
else
  SERVICE="/etc/systemd/system/${APP_NAME}.service"
  cat > "${SERVICE}" <<SERVICEEOF
[Unit]
Description=Blox_invite_form contact form (Blox.Global) — ALPHA
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICEEOF
  systemctl daemon-reload
  systemctl enable --now "${APP_NAME}.service"
  echo "==> Servicio systemd activo: ${APP_NAME}.service"
fi

echo
echo "Listo. Comprobacion:"
echo "  curl -s http://127.0.0.1:8090/form/api/health"
echo "Recuerda poner un proxy inverso (Caddy/nginx) delante si quieres HTTPS."
