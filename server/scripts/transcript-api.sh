#!/usr/bin/env bash
# Manage transcript-api on Ubuntu (background via gunicorn).
#
# Usage (from server/ directory, or any cwd):
#   ./scripts/transcript-api.sh start
#   ./scripts/transcript-api.sh stop
#   ./scripts/transcript-api.sh restart
#   ./scripts/transcript-api.sh status
#
# Env (optional): HOST PORT WORKERS THREADS WEB_CONCURRENCY .env file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${APP_DIR}/run/transcript-api.pid"
LOG_DIR="${APP_DIR}/logs"
LOG_FILE="${LOG_DIR}/transcript-api.log"
VENV_DIR="${APP_DIR}/.venv"
ENV_FILE="${APP_DIR}/.env"

mkdir -p "${APP_DIR}/run" "${LOG_DIR}"

load_env() {
  if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
  fi
}

ensure_venv() {
  if [[ ! -x "${VENV_DIR}/bin/gunicorn" ]]; then
    echo "[transcript-api] Creating venv + installing deps..."
    python3 -m venv "${VENV_DIR}"
    # shellcheck disable=SC1091
    source "${VENV_DIR}/bin/activate"
    pip install -q --upgrade pip
    pip install -q -r "${APP_DIR}/requirements.txt"
  else
    # shellcheck disable=SC1091
    source "${VENV_DIR}/bin/activate"
  fi
}

is_running() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -z "${pid}" ]]; then
    return 1
  fi
  if kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi
  # stale pid
  rm -f "${PID_FILE}"
  return 1
}

cmd_start() {
  load_env
  ensure_venv

  if is_running; then
    echo "[transcript-api] Already running (pid=$(cat "${PID_FILE}"))"
    exit 0
  fi

  local host="${HOST:-0.0.0.0}"
  local port="${PORT:-5000}"
  local workers="${WORKERS:-1}"
  local threads="${THREADS:-20}"
  local timeout="${TIMEOUT:-120}"

  echo "[transcript-api] Starting on ${host}:${port} (gthread workers=${workers} threads=${threads})"
  cd "${APP_DIR}"

  # Single worker required (in-memory job/worker state)
  nohup gunicorn \
    --worker-class gthread \
    --workers "${workers}" \
    --threads "${threads}" \
    --bind "${host}:${port}" \
    --timeout "${timeout}" \
    --access-logfile "${LOG_DIR}/access.log" \
    --error-logfile "${LOG_FILE}" \
    --capture-output \
    --pid "${PID_FILE}" \
    --daemon \
    wsgi:app

  sleep 0.5
  if is_running; then
    echo "[transcript-api] Started pid=$(cat "${PID_FILE}")"
    echo "[transcript-api] Logs: ${LOG_FILE}"
    echo "[transcript-api] Health: curl -s http://127.0.0.1:${port}/health"
  else
    echo "[transcript-api] Failed to start — see ${LOG_FILE}" >&2
    exit 1
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "[transcript-api] Not running"
    rm -f "${PID_FILE}"
    exit 0
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  echo "[transcript-api] Stopping pid=${pid}..."
  kill "${pid}" 2>/dev/null || true

  for _ in $(seq 1 20); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done

  if kill -0 "${pid}" 2>/dev/null; then
    echo "[transcript-api] Force kill pid=${pid}"
    kill -9 "${pid}" 2>/dev/null || true
  fi

  rm -f "${PID_FILE}"
  echo "[transcript-api] Stopped"
}

cmd_restart() {
  cmd_stop || true
  cmd_start
}

cmd_status() {
  load_env
  local port="${PORT:-5000}"
  if is_running; then
    echo "[transcript-api] Running pid=$(cat "${PID_FILE}")"
    curl -fsS "http://127.0.0.1:${port}/health" && echo || echo "(health check failed)"
  else
    echo "[transcript-api] Not running"
    exit 1
  fi
}

cmd_logs() {
  mkdir -p "${LOG_DIR}"
  touch "${LOG_FILE}"
  tail -n 100 -f "${LOG_FILE}"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <start|stop|restart|status|logs>

  start    Start API in background (gunicorn --daemon)
  stop     Stop background process
  restart  stop + start
  status   Show pid + /health
  logs     Tail error log

Config: ${ENV_FILE}
  HOST=0.0.0.0 PORT=5000 WORKERS=1 THREADS=20
EOF
}

main() {
  local action="${1:-}"
  case "${action}" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    -h|--help|help|"") usage; [[ -n "${action}" ]] || exit 1 ;;
    *)
      echo "Unknown command: ${action}" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
