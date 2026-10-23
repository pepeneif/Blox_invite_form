#!/usr/bin/env bash
# Prueba de humo end-to-end SIN mandar correo real:
#   - levanta un SMTP de mentira
#   - arranca el servidor apuntando a el
#   - comprueba /form/api/health, un POST valido y otro invalido
#   - verifica que el mensaje capturado lleva el destinatario correcto
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_PORT="${FAKE_PORT:-2525}"
APP_PORT="${APP_PORT:-8099}"
OUT="$(mktemp -t blox-captured-XXXXXX.eml)"

cleanup() {
  [[ -n "${APP_PID:-}" ]] && kill "${APP_PID}" 2>/dev/null || true
  [[ -n "${SMTP_PID:-}" ]] && kill "${SMTP_PID}" 2>/dev/null || true
}
trap cleanup EXIT

node "${ROOT}/scripts/fake-smtp.js" "${FAKE_PORT}" "${OUT}" &
SMTP_PID=$!
sleep 0.5

FORM_HOST=127.0.0.1 FORM_PORT="${APP_PORT}" \
SMTP_HOST=127.0.0.1 SMTP_PORT="${FAKE_PORT}" SMTP_SECURITY=plain \
MAIL_FROM=bot@bloxcross.com FROM_HEADER='Bot <bot@bloxcross.com>' \
MAIL_TO=admin@bloxcross.com \
node "${ROOT}/server.js" &
APP_PID=$!

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${APP_PORT}/form/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "--- health"
curl -s "http://127.0.0.1:${APP_PORT}/form/api/health"; echo

echo "--- pagina (primeras lineas)"
curl -s "http://127.0.0.1:${APP_PORT}/" | head -3

echo "--- POST invalido (telefono con letras)"
curl -s -X POST "http://127.0.0.1:${APP_PORT}/form/api/send" \
  -H 'Content-Type: application/json' \
  -d '{"rows":[{"name":"Ana","email":"ana@example.com","phone":"abc"}]}'; echo

echo "--- POST renglon a medias"
curl -s -X POST "http://127.0.0.1:${APP_PORT}/form/api/send" \
  -H 'Content-Type: application/json' \
  -d '{"rows":[{"name":"Ana","email":"","phone":""}]}'; echo

echo "--- POST valido"
curl -s -X POST "http://127.0.0.1:${APP_PORT}/form/api/send" \
  -H 'Content-Type: application/json' \
  -d '{"rows":[{"name":"Ana Lopez","email":"ana@example.com","phone":"+34 600 123 456"},{"name":"Bob","email":"bob@example.org","phone":"600-000-111"}]}'; echo

sleep 0.5
echo "--- mensaje capturado (cabeceras y cuerpo)"
cat "${OUT}"
echo
echo "--- comprobaciones"
grep -q "To: admin@bloxcross.com" "${OUT}" && echo "OK  destinatario = admin@bloxcross.com" || { echo "FALLO destinatario"; exit 1; }
grep -q "Ana Lopez | ana@example.com | +34 600 123 456" "${OUT}" && echo "OK  primer contacto en el cuerpo" || { echo "FALLO cuerpo"; exit 1; }
grep -q "Bob | bob@example.org | 600-000-111" "${OUT}" && echo "OK  segundo contacto en el cuerpo" || { echo "FALLO cuerpo"; exit 1; }

echo "TODO OK"
