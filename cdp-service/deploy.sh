#!/bin/bash
# CDP Service deployment script

set -e

SERVICE_DIR="/opt/openclaw/cdp-service"
CONFIG_FILE="${SERVICE_DIR}/config.yaml"
PID_FILE="${SERVICE_DIR}/cdp-service.pid"
LOG_FILE="${SERVICE_DIR}/logs/service.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

start() {
  if [ -f "$PID_FILE" ]; then
    if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
      log_error "Service already running (PID: $(cat $PID_FILE))"
      exit 1
    else
      log_warn "Removing stale PID file"
      rm -f "$PID_FILE"
    fi
  fi

  log_info "Starting CDP Service"

  # Create logs directory if it doesn't exist
  mkdir -p "$(dirname $LOG_FILE)"

  # Start service
  node "${SERVICE_DIR}/dist/index.js" "${CONFIG_FILE}" >> "${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"

  # Wait a bit and check if it's still running
  sleep 2
  if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    log_info "CDP Service started successfully (PID: $(cat $PID_FILE))"
  else
    log_error "CDP Service failed to start. Check logs: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    log_warn "Service not running (no PID file found)"
    return 0
  fi

  PID=$(cat "$PID_FILE")

  if ! kill -0 "$PID" 2>/dev/null; then
    log_warn "Service not running (PID $PID not found)"
    rm -f "$PID_FILE"
    return 0
  fi

  log_info "Stopping CDP Service (PID: $PID)"
  kill -TERM "$PID"

  # Wait for graceful shutdown
  for i in {1..30}; do
    if ! kill -0 "$PID" 2>/dev/null; then
      rm -f "$PID_FILE"
      log_info "Service stopped gracefully"
      return 0
    fi
    sleep 1
  done

  # Force kill if still running
  log_warn "Graceful shutdown timeout, force killing"
  kill -9 "$PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  log_info "Service forcefully stopped"
}

status() {
  if [ ! -f "$PID_FILE" ]; then
    log_info "Service is not running"
    return 1
  fi

  PID=$(cat "$PID_FILE")

  if kill -0 "$PID" 2>/dev/null; then
    log_info "Service is running (PID: $PID)"

    # Check health endpoint
    if command -v curl &> /dev/null; then
      log_info "Checking health endpoint..."
      curl -f http://localhost:3100/health 2>/dev/null && echo "" || log_warn "Health check failed"
    fi
    return 0
  else
    log_error "Service is not running (stale PID file)"
    rm -f "$PID_FILE"
    return 1
  fi
}

restart() {
  log_info "Restarting CDP Service"
  stop
  sleep 2
  start
}

case "$1" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    restart
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
