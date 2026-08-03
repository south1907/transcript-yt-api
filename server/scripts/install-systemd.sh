#!/usr/bin/env bash
# Install systemd unit on Ubuntu.
# Usage:
#   sudo ./scripts/install-systemd.sh [/opt/transcript-api]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_ROOT="${1:-/opt/transcript-api}"
SERVICE_SRC="${APP_DIR}/deploy/transcript-api.service"
SERVICE_DST="/etc/systemd/system/transcript-api.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0 [install_root]" >&2
  exit 1
fi

echo "[install] Copy server → ${INSTALL_ROOT}/server"
mkdir -p "${INSTALL_ROOT}/server/logs" "${INSTALL_ROOT}/server/run"
rsync -a \
  --exclude '.venv' \
  --exclude 'run/' \
  --exclude 'logs/' \
  --exclude '__pycache__/' \
  --exclude '.env' \
  "${APP_DIR}/" "${INSTALL_ROOT}/server/"

if [[ ! -f "${INSTALL_ROOT}/server/.env" ]]; then
  cp "${APP_DIR}/.env.example" "${INSTALL_ROOT}/server/.env"
  echo "[install] Wrote default ${INSTALL_ROOT}/server/.env"
fi

echo "[install] Python venv + deps"
python3 -m venv "${INSTALL_ROOT}/server/.venv"
"${INSTALL_ROOT}/server/.venv/bin/pip" install -q --upgrade pip
"${INSTALL_ROOT}/server/.venv/bin/pip" install -q -r "${INSTALL_ROOT}/server/requirements.txt"

if ! id -u www-data >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin www-data
fi
chown -R www-data:www-data "${INSTALL_ROOT}/server/logs" "${INSTALL_ROOT}/server/run"
chown -R root:www-data "${INSTALL_ROOT}/server"
chmod -R g+rX "${INSTALL_ROOT}/server"
# venv must be executable by www-data
chmod -R a+rX "${INSTALL_ROOT}/server/.venv"

sed "s|/opt/transcript-api|${INSTALL_ROOT}|g" "${SERVICE_SRC}" > "${SERVICE_DST}"

systemctl daemon-reload
systemctl enable transcript-api
systemctl restart transcript-api
systemctl --no-pager --full status transcript-api || true

echo
echo "Commands:"
echo "  sudo systemctl start transcript-api"
echo "  sudo systemctl stop transcript-api"
echo "  sudo systemctl restart transcript-api"
echo "  sudo systemctl status transcript-api"
echo "  curl -s http://127.0.0.1:\${PORT:-5000}/health"
