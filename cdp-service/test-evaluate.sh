#!/bin/bash
# Test evaluate API

export CDP_SERVICE_TOKEN="test-token-123"

# Start service
node dist/index.js config.yaml > service.log 2>&1 &
SERVICE_PID=$!

# Wait for service to start
sleep 3

echo "=== Testing simple evaluate ==="
curl -s -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"expression": "1 + 1", "budget": {"timeoutMs": 5000}}'

echo ""
echo ""
echo "=== Service logs ==="
tail -30 service.log

# Cleanup
kill $SERVICE_PID 2>/dev/null || true
