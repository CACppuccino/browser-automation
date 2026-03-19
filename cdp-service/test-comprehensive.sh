#!/bin/bash
# Comprehensive evaluate tests

export CDP_SERVICE_TOKEN="test-token-123"

# Start service
node dist/index.js config.yaml > service.log 2>&1 &
SERVICE_PID=$!
sleep 3

echo "=========================================="
echo "Test 1: Basic arithmetic"
echo "=========================================="
curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"expression": "10 * 5 + 3", "budget": {"timeoutMs": 5000}}' | python3 -m json.tool

echo ""
echo "=========================================="
echo "Test 2: Complex expression"
echo "=========================================="
curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"expression": "Math.sqrt(144)", "budget": {"timeoutMs": 5000}}' | python3 -m json.tool

echo ""
echo "=========================================="
echo "Test 3: Async expression"
echo "=========================================="
curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"expression": "Promise.resolve(42)", "awaitPromise": true, "budget": {"timeoutMs": 5000}}' | python3 -m json.tool

echo ""
echo "=========================================="
echo "Test 4: Timeout test (2 second limit)"
echo "=========================================="
# Service should timeout after 2s, long before the 5s promise resolves
curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"expression": "new Promise(r => setTimeout(() => r(99), 10000))", "awaitPromise": true, "budget": {"timeoutMs": 2000}}' | python3 -m json.tool || echo "Expected timeout error occurred"

echo ""
echo "=========================================="
echo "Test 5: Concurrent requests (3 parallel)"
echo "=========================================="

curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "agent-1", "expression": "1+1", "budget": {"timeoutMs": 5000}}' &

curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "agent-2", "expression": "2+2", "budget": {"timeoutMs": 5000}}' &

curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "agent-3", "expression": "3+3", "budget": {"timeoutMs": 5000}}' &

wait

echo ""
echo "=========================================="
echo "Service Stats"
echo "=========================================="
curl -s http://localhost:3100/health | python3 -m json.tool

# Cleanup
kill $SERVICE_PID 2>/dev/null || true
