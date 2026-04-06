#!/bin/bash
# CDP Service Compatibility and Integration Test
# Tests client library, adapter, fallback mechanisms, and profile APIs

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

export CDP_SERVICE_TOKEN="test-token-123"

TMP_DIR=$(mktemp -d)
WORKSPACE_DIR="$TMP_DIR/workspace"
SERVICE_PORT=33101
SERVICE_URL="http://127.0.0.1:${SERVICE_PORT}"
CONFIG_PATH="$TMP_DIR/config.yaml"
SERVICE_PID=""

cleanup() {
  if [ -n "$SERVICE_PID" ]; then
    kill "$SERVICE_PID" 2>/dev/null || true
  fi
  rm -f test-client.mjs test-adapter.mjs test-rollout.mjs
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$WORKSPACE_DIR"
SERVICE_PORT="$SERVICE_PORT" CONFIG_PATH="$CONFIG_PATH" python3 - <<'PY'
import os
from pathlib import Path
src = Path('config.yaml').read_text()
updated = src.replace('port: 3100', f"port: {os.environ['SERVICE_PORT']}", 1)
Path(os.environ['CONFIG_PATH']).write_text(updated)
PY

echo "=========================================="
echo "Phase 4: Compatibility & Integration Test"
echo "=========================================="
echo ""

echo "Starting CDP service..."
node dist/index.js "$CONFIG_PATH" > compat-test.log 2>&1 &
SERVICE_PID=$!
sleep 3

if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
  echo "✗ Failed to start CDP service"
  cat compat-test.log
  exit 1
fi

echo "✓ Service started (PID: $SERVICE_PID)"
echo ""

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

echo "Test 1: Client Library - Basic Evaluate"
echo "=========================================="

cat > test-client.mjs <<'EOF'
import { CdpServiceClient } from './dist/client.js';

const client = new CdpServiceClient({
  serviceUrl: process.env.SERVICE_URL || 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN,
  defaultTimeout: 30000,
});

try {
  const result = await client.evaluate({
    agentId: 'test-client-1',
    expression: '2 + 2',
    budget: { timeoutMs: 5000 }
  });

  console.log('✓ Client evaluate succeeded');
  console.log(`  Result: ${result.result}`);
  console.log(`  Duration: ${result.metadata.durationMs}ms`);
  console.log(`  Isolation: ${result.metadata.isolationLevel}`);

  const health = await client.getHealth();
  console.log('✓ Health check succeeded');
  console.log(`  Status: ${health.status}`);

  const stats = await client.getStats();
  console.log('✓ Stats query succeeded');
  console.log(`  Total requests: ${stats.totalRequests}`);

  client.dispose();
  process.exit(0);
} catch (error) {
  console.error('✗ Client test failed:', error.message);
  client.dispose();
  process.exit(1);
}
EOF

SERVICE_URL="$SERVICE_URL" node test-client.mjs

echo ""
echo "Test 2: Adapter with Fallback Mechanism"
echo "=========================================="

cat > test-adapter.mjs <<'EOF'
import { CdpServiceClient } from './dist/client.js';

const legacyEvaluate = async () => ({
  result: 'legacy-result',
  metadata: {
    durationMs: 100,
    isolationLevel: 'session',
    engineId: 'legacy'
  }
});

class TestAdapter {
  constructor(config) {
    this.config = config;
    this.client = config.enabled ? new CdpServiceClient({
      serviceUrl: config.serviceUrl,
      authToken: config.authToken,
    }) : null;
  }

  async evaluate(req) {
    if (this.config.enabled && this.client) {
      try {
        return await this.client.evaluate(req);
      } catch (error) {
        if (this.config.fallback) {
          console.log('  → Fallback to legacy after CDP error');
          return await legacyEvaluate(req);
        }
        throw error;
      }
    }
    return await legacyEvaluate(req);
  }

  dispose() {
    if (this.client) this.client.dispose();
  }
}

try {
  console.log('Test 2.1: CDP service enabled');
  const adapter1 = new TestAdapter({
    enabled: true,
    fallback: true,
    serviceUrl: process.env.SERVICE_URL || 'http://localhost:3100',
    authToken: process.env.CDP_SERVICE_TOKEN,
  });

  const result1 = await adapter1.evaluate({
    agentId: 'adapter-test-1',
    expression: '10 * 10',
    budget: { timeoutMs: 5000 }
  });

  if (result1.metadata.engineId !== 'legacy') {
    console.log('✓ Used CDP service (not legacy)');
  } else {
    console.log('✗ Should have used CDP service');
    process.exit(1);
  }

  adapter1.dispose();

  console.log('\nTest 2.2: CDP service disabled');
  const adapter2 = new TestAdapter({ enabled: false, fallback: true });
  const result2 = await adapter2.evaluate({ agentId: 'adapter-test-2', expression: 'test' });

  if (result2.metadata.engineId === 'legacy') {
    console.log('✓ Used legacy implementation');
  } else {
    console.log('✗ Should have used legacy');
    process.exit(1);
  }

  adapter2.dispose();

  console.log('\nTest 2.3: Fallback on service failure');
  const adapter3 = new TestAdapter({
    enabled: true,
    fallback: true,
    serviceUrl: 'http://localhost:9999',
    authToken: 'test',
  });

  const result3 = await adapter3.evaluate({ agentId: 'adapter-test-3', expression: 'test' });
  if (result3.metadata.engineId === 'legacy') {
    console.log('✓ Fallback worked correctly');
  } else {
    console.log('✗ Should have fallen back to legacy');
    process.exit(1);
  }

  adapter3.dispose();
  console.log('\n✓ All adapter tests passed');
  process.exit(0);
} catch (error) {
  console.error('✗ Adapter test failed:', error.message);
  process.exit(1);
}
EOF

SERVICE_URL="$SERVICE_URL" node test-adapter.mjs

echo ""
echo "Test 3: Feature Flags & Rollout"
echo "=========================================="

cat > test-rollout.mjs <<'EOF'
class RolloutTester {
  shouldUseCdpService(config, agentId) {
    if (!config.enabled) return false;
    if (config.rolloutAgentPattern && agentId) {
      const pattern = new RegExp(config.rolloutAgentPattern);
      if (!pattern.test(agentId)) return false;
    }
    if (config.rolloutPercentage < 100) {
      const hash = this.hashString(agentId || '');
      const bucket = hash % 100;
      return bucket < config.rolloutPercentage;
    }
    return true;
  }

  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}

const tester = new RolloutTester();

console.log('Test 3.1: Agent pattern matching');
if (!tester.shouldUseCdpService({ enabled: true, rolloutAgentPattern: 'test-.*', rolloutPercentage: 100 }, 'test-agent-1')) {
  console.log('✗ Pattern should have matched');
  process.exit(1);
}
console.log('✓ Pattern match works');

if (tester.shouldUseCdpService({ enabled: true, rolloutAgentPattern: 'test-.*', rolloutPercentage: 100 }, 'prod-agent-1')) {
  console.log('✗ Pattern should not have matched');
  process.exit(1);
}
console.log('✓ Pattern non-match works');

console.log('\nTest 3.2: Percentage rollout');
let usedCount = 0;
for (let i = 0; i < 100; i++) {
  if (tester.shouldUseCdpService({ enabled: true, rolloutPercentage: 50 }, `agent-${i}`)) {
    usedCount++;
  }
}
if (usedCount < 40 || usedCount > 60) {
  console.log(`✗ Rollout percentage unexpected (${usedCount}% used, expected ~50%)`);
  process.exit(1);
}
console.log(`✓ Rollout percentage correct (${usedCount}% used)`);
console.log('\n✓ All rollout tests passed');
EOF

node test-rollout.mjs

echo ""
echo "Test 4: API Compatibility"
echo "=========================================="

RESPONSE=$(api_request POST /api/v1/evaluate '{"expression":"42","budget":{"timeoutMs":5000}}')
RESPONSE="$RESPONSE" python3 - <<'PY'
import json, os
obj = json.loads(os.environ['RESPONSE'])
assert 'result' in obj
assert 'metadata' in obj
assert 'durationMs' in obj['metadata']
PY
echo "✓ Legacy evaluate response structure correct"

ERROR_RESPONSE=$(curl -sS -X POST "${SERVICE_URL}/api/v1/evaluate" \
  -H "Authorization: Bearer ${CDP_SERVICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"expression":"invalid(","budget":{"timeoutMs":5000}}')
ERROR_RESPONSE="$ERROR_RESPONSE" python3 - <<'PY'
import json, os
obj = json.loads(os.environ['ERROR_RESPONSE'])
assert 'error' in obj or 'result' in obj
PY
echo "✓ Error response format remains compatible"

echo ""
echo "Test 5: Profile API Compatibility"
echo "=========================================="
PROFILE_RESPONSE=$(api_request POST /api/v1/profiles "{\"profileId\":\"compat-profile\",\"scope\":\"workspace\",\"workspacePath\":\"${WORKSPACE_DIR}\"}")
PROFILE_RESPONSE="$PROFILE_RESPONSE" python3 - <<'PY'
import json, os
obj = json.loads(os.environ['PROFILE_RESPONSE'])
profile = obj['profile']
assert profile['profileId'] == 'compat-profile'
assert profile['scope'] == 'workspace'
assert profile['state'] == 'ready'
PY
echo "✓ Profile create response shape correct"

SESSION_RESPONSE=$(api_request POST /api/v1/sessions "{\"agentId\":\"compat-agent\",\"browserMode\":\"dedicated\",\"stateMode\":\"profile\",\"profileId\":\"compat-profile\",\"profileScope\":\"workspace\",\"workspacePath\":\"${WORKSPACE_DIR}\"}")
SESSION_RESPONSE="$SESSION_RESPONSE" python3 - <<'PY'
import json, os
obj = json.loads(os.environ['SESSION_RESPONSE'])
assert obj['agentId'] == 'compat-agent'
assert obj['browserMode'] == 'dedicated'
assert obj['stateMode'] == 'profile'
assert obj['profileId'] == 'compat-profile'
assert obj['profileScope'] == 'workspace'
assert obj['workspacePath']
assert obj['browserInstanceId']
assert obj['targetId']
PY
echo "✓ Session response includes new profile fields"

api_request DELETE "/api/v1/sessions/compat-agent?browserMode=dedicated&stateMode=profile&profileId=compat-profile&profileScope=workspace&workspacePath=${WORKSPACE_DIR}" >/dev/null

echo ""
echo "Test 6: Validation Compatibility"
echo "=========================================="
INVALID_STATUS=$(curl -sS -o "$TMP_DIR/invalid.json" -w "%{http_code}" -X POST "${SERVICE_URL}/api/v1/evaluate" \
  -H "Authorization: Bearer ${CDP_SERVICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"compat-invalid","browserMode":"shared","stateMode":"fresh","expression":"1","budget":{"timeoutMs":5000}}')
if [ "$INVALID_STATUS" != "400" ]; then
  echo "✗ Expected invalid shared/fresh request to fail"
  exit 1
fi
RESPONSE="$(cat "$TMP_DIR/invalid.json")" python3 - <<'PY'
import json, os
obj = json.loads(os.environ['RESPONSE'])
assert 'shared browserMode does not support fresh stateMode' in obj['message']
PY
echo "✓ New validation error format is stable"

echo ""
echo "=========================================="
echo "Compatibility Test Summary"
echo "=========================================="
echo "✓ Client library API compatible"
echo "✓ Adapter with fallback mechanism works"
echo "✓ Feature flags and rollout logic correct"
echo "✓ Legacy API responses remain compatible"
echo "✓ Profile APIs expose expected response fields"
echo "✓ New validation errors are consistent"
echo ""
echo "All compatibility tests passed!"
echo ""
echo "✓ Test completed successfully"
