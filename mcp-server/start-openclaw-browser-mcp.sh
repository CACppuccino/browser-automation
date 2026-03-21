#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/mike/Projects/browser-automation"
MCP_DIR="$ROOT/mcp-server"
CDP_DIR="$ROOT/cdp-service"
LOG_DIR="${OPENCLAW_LOG_DIR:-/tmp/openclaw-browser-mcp}"
CHROME_BIN="${OPENCLAW_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CHROME_USER_DATA_DIR="${OPENCLAW_CHROME_USER_DATA_DIR:-/tmp/browser-automation-chrome}"
CHROME_DEBUG_PORT="${OPENCLAW_CHROME_DEBUG_PORT:-9222}"
CDP_SERVICE_PORT="${OPENCLAW_CDP_SERVICE_PORT:-3100}"
CDP_SERVICE_URL_DEFAULT="http://127.0.0.1:${CDP_SERVICE_PORT}"
CDP_CONFIG_PATH="${OPENCLAW_CDP_CONFIG_PATH:-$CDP_DIR/config.yaml}"

export CDP_SERVICE_URL="${CDP_SERVICE_URL:-$CDP_SERVICE_URL_DEFAULT}"
export CDP_SERVICE_TOKEN="${CDP_SERVICE_TOKEN:-test-token-123}"

mkdir -p "$LOG_DIR"

wait_for_http() {
  local url="$1"
  local attempts="$2"
  local delay="$3"
  local i

  for ((i = 0; i < attempts; i += 1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

kill_port() {
  local port="$1"
  local pids

  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill $pids >/dev/null 2>&1 || true
    sleep 1
  fi
}

ensure_deps() {
  if [ ! -d "$MCP_DIR/node_modules" ]; then
    npm --prefix "$MCP_DIR" install >"$LOG_DIR/mcp-install.log" 2>&1
  fi

  if [ ! -d "$CDP_DIR/node_modules" ]; then
    npm --prefix "$CDP_DIR" install >"$LOG_DIR/cdp-install.log" 2>&1
  fi

  if [ ! -f "$CDP_DIR/dist/index.js" ]; then
    npm --prefix "$CDP_DIR" run build >"$LOG_DIR/cdp-build.log" 2>&1
  fi
}

ensure_chrome() {
  if curl -fsS "http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version" >/dev/null 2>&1; then
    return 0
  fi

  kill_port "$CHROME_DEBUG_PORT"

  nohup "$CHROME_BIN" \
    --remote-debugging-port="$CHROME_DEBUG_PORT" \
    --user-data-dir="$CHROME_USER_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    about:blank >"$LOG_DIR/chrome.log" 2>&1 &

  wait_for_http "http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version" 30 1 || {
    echo "Failed to start Chrome CDP on port ${CHROME_DEBUG_PORT}" >&2
    exit 1
  }
}

service_is_healthy() {
  curl -fsS "$CDP_SERVICE_URL/health" 2>/dev/null | grep -q '"status":"healthy"'
}

ensure_service() {
  if service_is_healthy; then
    return 0
  fi

  kill_port "$CDP_SERVICE_PORT"

  nohup env CDP_SERVICE_TOKEN="$CDP_SERVICE_TOKEN" \
    node "$CDP_DIR/dist/index.js" "$CDP_CONFIG_PATH" >"$LOG_DIR/cdp-service.log" 2>&1 &

  local i
  for ((i = 0; i < 30; i += 1)); do
    if service_is_healthy; then
      return 0
    fi
    sleep 1
  done

  echo "Failed to start CDP service on port ${CDP_SERVICE_PORT}" >&2
  exit 1
}

ensure_deps
ensure_chrome
ensure_service

exec node "$MCP_DIR/index.js"
