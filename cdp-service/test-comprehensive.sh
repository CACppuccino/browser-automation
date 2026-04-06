#!/bin/bash
# Comprehensive evaluate and profile persistence tests

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

export CDP_SERVICE_TOKEN="test-token-123"

TMP_DIR=$(mktemp -d)
WORKSPACE_DIR="$TMP_DIR/workspace"
SITE_DIR="$TMP_DIR/site"
SITE_PORT=32123
SERVICE_PORT=33100
SERVICE_URL="http://127.0.0.1:${SERVICE_PORT}"
SITE_URL="http://127.0.0.1:${SITE_PORT}"
CONFIG_PATH="$TMP_DIR/config.yaml"
SERVICE_PID=""
SITE_PID=""

cleanup() {
  if [ -n "$SERVICE_PID" ]; then
    kill "$SERVICE_PID" 2>/dev/null || true
  fi
  if [ -n "$SITE_PID" ]; then
    kill "$SITE_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$WORKSPACE_DIR" "$SITE_DIR"
SERVICE_PORT="$SERVICE_PORT" CONFIG_PATH="$CONFIG_PATH" python3 - <<'PY'
import os
from pathlib import Path
src = Path('config.yaml').read_text()
updated = src.replace('port: 3100', f"port: {os.environ['SERVICE_PORT']}", 1)
Path(os.environ['CONFIG_PATH']).write_text(updated)
PY

cat > "$SITE_DIR/index.html" <<'EOF'
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Profile Persistence Test</title>
  </head>
  <body>
    <h1>Profile Persistence Test Page</h1>
  </body>
</html>
EOF

python3 -m http.server "$SITE_PORT" --bind 127.0.0.1 --directory "$SITE_DIR" > "$TMP_DIR/site.log" 2>&1 &
SITE_PID=$!
sleep 1

node dist/index.js "$CONFIG_PATH" > "$TMP_DIR/service.log" 2>&1 &
SERVICE_PID=$!
sleep 3

if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
  echo "✗ Failed to start CDP service"
  cat "$TMP_DIR/service.log"
  exit 1
fi

api_request() {
  local method="$1"
  local path="$2"
  local body="${3-}"
  local response_file="$TMP_DIR/response.json"
  local status

  if [ -n "$body" ]; then
    status=$(curl -sS -o "$response_file" -w "%{http_code}" -X "$method" "${SERVICE_URL}${path}" \
      -H "Authorization: Bearer ${CDP_SERVICE_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$body")
  else
    status=$(curl -sS -o "$response_file" -w "%{http_code}" -X "$method" "${SERVICE_URL}${path}" \
      -H "Authorization: Bearer ${CDP_SERVICE_TOKEN}")
  fi

  cat "$response_file"
  if [ "$status" -ge 400 ]; then
    echo
    echo "✗ Request failed: ${method} ${path} (HTTP ${status})"
    exit 1
  fi
}

assert_json() {
  local payload="$1"
  local code="$2"
  RESPONSE="$payload" python3 - <<PY
import json, os
payload = os.environ.get('RESPONSE', '')
data = json.loads(payload) if payload else None
${code}
PY
}

wait_for_page() {
  local agent_id="$1"
  local extra_json="$2"
  for _ in $(seq 1 20); do
    local response
    response=$(api_request POST /api/v1/evaluate "{\"agentId\":\"${agent_id}\",\"browserMode\":\"dedicated\",${extra_json}\"expression\":\"({ url: window.location.href, readyState: document.readyState, title: document.title })\",\"budget\":{\"timeoutMs\":5000}}")
    if RESPONSE="$response" TARGET_URL="$SITE_URL/" python3 - <<'PY'
import json, os, sys
obj = json.loads(os.environ['RESPONSE'])
result = obj.get('result') or {}
if result.get('url') == os.environ['TARGET_URL'] and result.get('readyState') == 'complete':
    sys.exit(0)
sys.exit(1)
PY
    then
      return 0
    fi
    sleep 1
  done

  echo "✗ Timed out waiting for test page to load for agent ${agent_id}"
  exit 1
}

navigate_agent() {
  local agent_id="$1"
  local extra_json="$2"
  api_request POST /api/v1/evaluate "{\"agentId\":\"${agent_id}\",\"browserMode\":\"dedicated\",${extra_json}\"expression\":\"window.location.href = '${SITE_URL}/'; ({ scheduled: true, next: window.location.href })\",\"budget\":{\"timeoutMs\":5000}}" >/dev/null
  sleep 2
  wait_for_page "$agent_id" "$extra_json"
}

echo "=========================================="
echo "Test 1: Basic arithmetic"
echo "=========================================="
BASIC_RESPONSE=$(api_request POST /api/v1/evaluate '{"expression":"10 * 5 + 3","budget":{"timeoutMs":5000}}')
assert_json "$BASIC_RESPONSE" "assert data['result'] == 53"
echo "✓ Basic arithmetic passed"

echo ""
echo "=========================================="
echo "Test 2: Workspace profile create/list/get"
echo "=========================================="
CREATE_PROFILE_RESPONSE=$(api_request POST /api/v1/profiles "{\"profileId\":\"persist-profile\",\"scope\":\"workspace\",\"workspacePath\":\"${WORKSPACE_DIR}\",\"displayName\":\"Persistent Workspace Profile\"}")
assert_json "$CREATE_PROFILE_RESPONSE" "assert data['profile']['profileId'] == 'persist-profile'; assert data['profile']['scope'] == 'workspace'"
echo "✓ Profile creation passed"

LIST_PROFILE_RESPONSE=$(api_request GET "/api/v1/profiles?scope=workspace&workspacePath=${WORKSPACE_DIR}")
assert_json "$LIST_PROFILE_RESPONSE" "assert any(p['profileId'] == 'persist-profile' for p in data['profiles'])"
echo "✓ Profile listing passed"

GET_PROFILE_RESPONSE=$(api_request GET "/api/v1/profiles/persist-profile?scope=workspace&workspacePath=${WORKSPACE_DIR}")
assert_json "$GET_PROFILE_RESPONSE" "assert data['profile']['displayName'] == 'Persistent Workspace Profile'"
echo "✓ Profile lookup passed"

echo ""
echo "=========================================="
echo "Test 3: Profile persistence across dedicated restart"
echo "=========================================="
PROFILE_ACCESS_JSON="\"stateMode\":\"profile\",\"profileId\":\"persist-profile\",\"profileScope\":\"workspace\",\"workspacePath\":\"${WORKSPACE_DIR}\","
navigate_agent "profile-agent-1" "$PROFILE_ACCESS_JSON"

SET_PROFILE_STATE=$(api_request POST /api/v1/evaluate "{\"agentId\":\"profile-agent-1\",\"browserMode\":\"dedicated\",${PROFILE_ACCESS_JSON}\"expression\":\"(() => { localStorage.setItem('persistKey', 'persistValue'); document.cookie = 'persistCookie=persistValue; Max-Age=3600; path=/'; return { value: localStorage.getItem('persistKey'), cookie: document.cookie, url: window.location.href }; })()\",\"budget\":{\"timeoutMs\":5000}}")
assert_json "$SET_PROFILE_STATE" "assert data['result']['value'] == 'persistValue'; assert 'persistCookie=persistValue' in data['result']['cookie']"
echo "✓ Profile state written"

api_request DELETE "/api/v1/sessions/profile-agent-1?browserMode=dedicated&stateMode=profile&profileId=persist-profile&profileScope=workspace&workspacePath=${WORKSPACE_DIR}" >/dev/null
sleep 1

navigate_agent "profile-agent-2" "$PROFILE_ACCESS_JSON"
READ_PROFILE_STATE=$(api_request POST /api/v1/evaluate "{\"agentId\":\"profile-agent-2\",\"browserMode\":\"dedicated\",${PROFILE_ACCESS_JSON}\"expression\":\"(() => ({ value: localStorage.getItem('persistKey'), cookie: document.cookie, url: window.location.href }))()\",\"budget\":{\"timeoutMs\":5000}}")
assert_json "$READ_PROFILE_STATE" "assert data['result']['value'] == 'persistValue'; assert 'persistCookie=persistValue' in data['result']['cookie']; assert data['result']['url'].startswith('http://127.0.0.1:32123')"
echo "✓ Profile state persisted across restart"

api_request DELETE "/api/v1/sessions/profile-agent-2?browserMode=dedicated&stateMode=profile&profileId=persist-profile&profileScope=workspace&workspacePath=${WORKSPACE_DIR}" >/dev/null
sleep 1

echo ""
echo "=========================================="
echo "Test 4: Profile migration to global scope"
echo "=========================================="
MIGRATE_RESPONSE=$(api_request POST "/api/v1/profiles/persist-profile/migrate?scope=workspace&workspacePath=${WORKSPACE_DIR}" '{"targetProfileId":"persist-profile-global","targetScope":"global","mode":"copy"}')
assert_json "$MIGRATE_RESPONSE" "assert data['profile']['profileId'] == 'persist-profile-global'; assert data['profile']['scope'] == 'global'; assert data['profile']['migratedFrom']['profileId'] == 'persist-profile'"
echo "✓ Profile migration passed"

GLOBAL_ACCESS_JSON='"stateMode":"profile","profileId":"persist-profile-global","profileScope":"global",'
navigate_agent "profile-agent-global" "$GLOBAL_ACCESS_JSON"
READ_GLOBAL_STATE=$(api_request POST /api/v1/evaluate "{\"agentId\":\"profile-agent-global\",\"browserMode\":\"dedicated\",${GLOBAL_ACCESS_JSON}\"expression\":\"(() => ({ value: localStorage.getItem('persistKey'), cookie: document.cookie }))()\",\"budget\":{\"timeoutMs\":5000}}")
assert_json "$READ_GLOBAL_STATE" "assert data['result']['value'] == 'persistValue'; assert 'persistCookie=persistValue' in data['result']['cookie']"
echo "✓ Migrated global profile retained state"

api_request DELETE "/api/v1/sessions/profile-agent-global?browserMode=dedicated&stateMode=profile&profileId=persist-profile-global&profileScope=global" >/dev/null
sleep 1

echo ""
echo "=========================================="
echo "Test 5: Fresh instance isolation"
echo "=========================================="
FRESH_ONE_JSON='"stateMode":"fresh","freshInstanceId":"fresh-one",'
navigate_agent "fresh-agent" "$FRESH_ONE_JSON"
SET_FRESH_STATE=$(api_request POST /api/v1/evaluate "{\"agentId\":\"fresh-agent\",\"browserMode\":\"dedicated\",${FRESH_ONE_JSON}\"expression\":\"(() => { localStorage.setItem('freshOnly', 'yes'); document.cookie = 'freshCookie=yes; Max-Age=3600; path=/'; return { value: localStorage.getItem('freshOnly'), cookie: document.cookie }; })()\",\"budget\":{\"timeoutMs\":5000}}")
assert_json "$SET_FRESH_STATE" "assert data['result']['value'] == 'yes'; assert 'freshCookie=yes' in data['result']['cookie']"
echo "✓ Fresh instance state written"

api_request DELETE "/api/v1/sessions/fresh-agent?browserMode=dedicated&stateMode=fresh&freshInstanceId=fresh-one" >/dev/null
sleep 1

FRESH_TWO_JSON='"stateMode":"fresh","freshInstanceId":"fresh-two",'
navigate_agent "fresh-agent" "$FRESH_TWO_JSON"
READ_FRESH_STATE=$(api_request POST /api/v1/evaluate "{\"agentId\":\"fresh-agent\",\"browserMode\":\"dedicated\",${FRESH_TWO_JSON}\"expression\":\"(() => ({ value: localStorage.getItem('freshOnly'), cookie: document.cookie }))()\",\"budget\":{\"timeoutMs\":5000}}")
assert_json "$READ_FRESH_STATE" "assert data['result']['value'] in (None, 'null', ''); assert 'freshCookie=yes' not in data['result']['cookie']"
echo "✓ Fresh instances stay isolated"

api_request DELETE "/api/v1/sessions/fresh-agent?browserMode=dedicated&stateMode=fresh&freshInstanceId=fresh-two" >/dev/null
sleep 1

echo ""
echo "=========================================="
echo "Test 6: Shared+fresh validation"
echo "=========================================="
INVALID_STATUS=$(curl -sS -o "$TMP_DIR/invalid.json" -w "%{http_code}" -X POST "${SERVICE_URL}/api/v1/evaluate" \
  -H "Authorization: Bearer ${CDP_SERVICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"invalid-agent","browserMode":"shared","stateMode":"fresh","expression":"1","budget":{"timeoutMs":5000}}')
cat "$TMP_DIR/invalid.json"
if [ "$INVALID_STATUS" != "400" ]; then
  echo "✗ Expected shared+fresh validation failure"
  exit 1
fi
RESPONSE="$(cat "$TMP_DIR/invalid.json")" python3 - <<'PY'
import json, os
obj = json.loads(os.environ['RESPONSE'])
assert 'shared browserMode does not support fresh stateMode' in obj['message']
PY
echo "✓ Invalid shared+fresh combination rejected"

echo ""
echo "=========================================="
echo "Comprehensive Test Summary"
echo "=========================================="
echo "✓ Basic evaluate works"
echo "✓ Workspace profile CRUD works"
echo "✓ Profile persistence survives dedicated restart"
echo "✓ Profile migration to global scope works"
echo "✓ Fresh instances stay isolated"
echo "✓ Invalid shared/fresh combination rejected"
echo ""
echo "All comprehensive tests passed!"
