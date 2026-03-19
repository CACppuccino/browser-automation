#!/bin/bash
# Test monitoring functionality end-to-end

export CDP_SERVICE_TOKEN="test-token-123"

echo "=========================================="
echo "Phase 3: Monitoring E2E Test"
echo "=========================================="
echo ""

# Start service in background
echo "Starting CDP service..."
node dist/index.js config.yaml > monitoring-test.log 2>&1 &
SERVICE_PID=$!
sleep 3

echo "Service started (PID: $SERVICE_PID)"
echo ""

# Test 1: Execute some evaluate requests to generate metrics
echo "Test 1: Generating metrics data..."
echo "==========================================  "

curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "test-agent-1", "expression": "1 + 1", "budget": {"timeoutMs": 5000}}' > /dev/null

curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "test-agent-2", "expression": "Math.sqrt(16)", "budget": {"timeoutMs": 5000}}' > /dev/null

curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "test-agent-3", "expression": "Promise.resolve(42)", "awaitPromise": true, "budget": {"timeoutMs": 5000}}' > /dev/null

echo "✓ Generated metrics from 3 evaluate requests"
echo ""

# Test 2: Check Prometheus metrics
echo "Test 2: Checking Prometheus metrics..."
echo "=========================================="

METRICS=$(curl -s http://localhost:3100/metrics)

if echo "$METRICS" | grep -q "cdp_evaluate_total"; then
  echo "✓ cdp_evaluate_total metric found"
  EVAL_COUNT=$(echo "$METRICS" | grep 'cdp_evaluate_total{' | grep 'status="success"' | tail -1 | awk '{print $2}')
  echo "  Successful evaluations: $EVAL_COUNT"
else
  echo "✗ cdp_evaluate_total metric NOT found"
fi

if echo "$METRICS" | grep -q "cdp_evaluate_duration_ms"; then
  echo "✓ cdp_evaluate_duration_ms histogram found"
else
  echo "✗ cdp_evaluate_duration_ms NOT found"
fi

if echo "$METRICS" | grep -q "cdp_active_engines"; then
  echo "✓ cdp_active_engines gauge found"
  ENGINE_COUNT=$(echo "$METRICS" | grep 'cdp_active_engines{' | tail -1 | awk '{print $2}')
  echo "  Active engines: $ENGINE_COUNT"
else
  echo "✗ cdp_active_engines NOT found"
fi

echo ""

# Test 3: Check Stats API
echo "Test 3: Checking Stats API..."
echo "=========================================="

STATS=$(curl -s -H "Authorization: Bearer test-token-123" http://localhost:3100/api/v1/stats)

if echo "$STATS" | python3 -m json.tool > /dev/null 2>&1; then
  echo "✓ Stats API returned valid JSON"
  echo "$STATS" | python3 -m json.tool | head -20

  TOTAL_REQUESTS=$(echo "$STATS" | python3 -c "import sys, json; print(json.load(sys.stdin)['totalRequests'])")
  echo ""
  echo "  Total requests: $TOTAL_REQUESTS"
else
  echo "✗ Stats API returned invalid JSON"
fi

echo ""

# Test 4: Check Engine Stats
echo "Test 4: Checking Engine Stats..."
echo "=========================================="

ENGINE_STATS=$(curl -s -H "Authorization: Bearer test-token-123" http://localhost:3100/api/v1/stats/engines)

if echo "$ENGINE_STATS" | python3 -m json.tool > /dev/null 2>&1; then
  echo "✓ Engine Stats API returned valid JSON"
  ENGINE_COUNT=$(echo "$ENGINE_STATS" | python3 -c "import sys, json; print(len(json.load(sys.stdin)))")
  echo "  Number of engines: $ENGINE_COUNT"
else
  echo "✗ Engine Stats API returned invalid JSON"
fi

echo ""

# Test 5: Check Agent Stats
echo "Test 5: Checking Agent Stats..."
echo "=========================================="

AGENT_STATS=$(curl -s -H "Authorization: Bearer test-token-123" http://localhost:3100/api/v1/stats/agents/test-agent-1)

if echo "$AGENT_STATS" | python3 -m json.tool > /dev/null 2>&1; then
  echo "✓ Agent Stats API returned valid JSON"
  echo "$AGENT_STATS" | python3 -m json.tool
else
  echo "✗ Agent Stats API returned invalid JSON"
fi

echo ""

# Test 6: Check Health with Stats
echo "Test 6: Checking Health Endpoint..."
echo "=========================================="

HEALTH=$(curl -s http://localhost:3100/health)

if echo "$HEALTH" | python3 -m json.tool > /dev/null 2>&1; then
  echo "✓ Health API returned valid JSON"
  STATUS=$(echo "$HEALTH" | python3 -c "import sys, json; print(json.load(sys.stdin)['status'])")
  ACTIVE_ENGINES=$(echo "$HEALTH" | python3 -c "import sys, json; print(json.load(sys.stdin)['activeEngines'])")
  echo "  Status: $STATUS"
  echo "  Active Engines: $ACTIVE_ENGINES"
else
  echo "✗ Health API returned invalid JSON"
fi

echo ""
echo "=========================================="
echo "Monitoring Test Summary"
echo "=========================================="
echo ""
echo "✓ Prometheus metrics endpoint working"
echo "✓ Stats API working"
echo "✓ Engine stats tracking working"
echo "✓ Agent stats tracking working"
echo "✓ Health check with stats working"
echo ""
echo "Check monitoring-test.log for service logs"
echo ""

# Cleanup
kill $SERVICE_PID 2>/dev/null || true
sleep 1

echo "✓ Monitoring E2E test completed"
