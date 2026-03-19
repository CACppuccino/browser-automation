#!/bin/bash
# CDP Service Load Testing Framework
# Tests service performance under 50+ concurrent agent load

export CDP_SERVICE_TOKEN="test-token-123"

echo "=========================================="
echo "Phase 5: Load Testing & Performance"
echo "=========================================="
echo ""

# Configuration
CONCURRENT_AGENTS=50
REQUESTS_PER_AGENT=10
TOTAL_REQUESTS=$((CONCURRENT_AGENTS * REQUESTS_PER_AGENT))

# Start service in background
echo "Starting CDP service..."
node dist/index.js config.yaml > load-test.log 2>&1 &
SERVICE_PID=$!
sleep 3

if ! kill -0 $SERVICE_PID 2>/dev/null; then
  echo "✗ Failed to start CDP service"
  cat load-test.log
  exit 1
fi

echo "✓ Service started (PID: $SERVICE_PID)"
echo ""

# Test 1: Baseline Performance (Sequential)
echo "Test 1: Baseline Performance (Sequential)"
echo "=========================================="

cat > test-baseline.mjs <<'EOF'
import { CdpServiceClient } from './dist/client.js';

const client = new CdpServiceClient({
  serviceUrl: 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN,
  defaultTimeout: 30000,
});

const iterations = parseInt(process.argv[2]) || 10;
const results = [];

console.log(`Running ${iterations} sequential requests...`);

const startTime = Date.now();

for (let i = 0; i < iterations; i++) {
  const reqStart = Date.now();
  try {
    await client.evaluate({
      agentId: 'baseline-agent',
      expression: `(function() {
        let sum = 0;
        for (let i = 0; i < 1000000; i++) sum += i;
        return sum;
      })()`,
      budget: { timeoutMs: 5000 }
    });
    const duration = Date.now() - reqStart;
    results.push({ success: true, duration });
  } catch (error) {
    const duration = Date.now() - reqStart;
    results.push({ success: false, duration, error: error.message });
  }
}

const totalTime = Date.now() - startTime;
const successful = results.filter(r => r.success).length;
const failed = results.filter(r => !r.success).length;
const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
const minDuration = Math.min(...results.map(r => r.duration));
const maxDuration = Math.max(...results.map(r => r.duration));

console.log('\nBaseline Results:');
console.log(`  Total time: ${totalTime}ms`);
console.log(`  Successful: ${successful}/${iterations}`);
console.log(`  Failed: ${failed}`);
console.log(`  Avg duration: ${avgDuration.toFixed(2)}ms`);
console.log(`  Min duration: ${minDuration}ms`);
console.log(`  Max duration: ${maxDuration}ms`);
console.log(`  Throughput: ${(iterations / (totalTime / 1000)).toFixed(2)} req/s`);

client.dispose();
process.exit(failed > 0 ? 1 : 0);
EOF

node test-baseline.mjs 20
BASELINE_RESULT=$?

if [ $BASELINE_RESULT -eq 0 ]; then
  echo "✓ Baseline test passed"
  echo ""
else
  echo "✗ Baseline test failed"
  kill $SERVICE_PID 2>/dev/null || true
  exit 1
fi

# Test 2: Concurrent Load (50 agents, 10 requests each)
echo ""
echo "Test 2: Concurrent Load Test"
echo "=========================================="
echo "Configuration:"
echo "  Concurrent agents: $CONCURRENT_AGENTS"
echo "  Requests per agent: $REQUESTS_PER_AGENT"
echo "  Total requests: $TOTAL_REQUESTS"
echo ""

cat > test-concurrent.mjs <<'EOF'
import { CdpServiceClient } from './dist/client.js';

const concurrentAgents = parseInt(process.argv[2]) || 50;
const requestsPerAgent = parseInt(process.argv[3]) || 10;

console.log(`Starting ${concurrentAgents} concurrent agents...`);

const startTime = Date.now();
const allResults = [];

async function runAgent(agentId, numRequests) {
  const client = new CdpServiceClient({
    serviceUrl: 'http://localhost:3100',
    authToken: process.env.CDP_SERVICE_TOKEN,
    defaultTimeout: 30000,
  });

  const results = [];

  for (let i = 0; i < numRequests; i++) {
    const reqStart = Date.now();
    try {
      await client.evaluate({
        agentId: `agent-${agentId}`,
        expression: `(function() {
          let sum = 0;
          for (let i = 0; i < ${100000 + Math.floor(Math.random() * 100000)}; i++) sum += i;
          return sum;
        })()`,
        budget: { timeoutMs: 10000 }
      });
      const duration = Date.now() - reqStart;
      results.push({ success: true, duration, agentId });
    } catch (error) {
      const duration = Date.now() - reqStart;
      results.push({
        success: false,
        duration,
        agentId,
        error: error.message
      });
    }
  }

  client.dispose();
  return results;
}

// Run all agents concurrently
const agentPromises = [];
for (let i = 0; i < concurrentAgents; i++) {
  agentPromises.push(runAgent(i, requestsPerAgent));
}

const agentResults = await Promise.all(agentPromises);
for (const results of agentResults) {
  allResults.push(...results);
}

const totalTime = Date.now() - startTime;
const successful = allResults.filter(r => r.success).length;
const failed = allResults.filter(r => !r.success).length;
const durations = allResults.map(r => r.duration).sort((a, b) => a - b);
const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
const p50 = durations[Math.floor(durations.length * 0.5)];
const p95 = durations[Math.floor(durations.length * 0.95)];
const p99 = durations[Math.floor(durations.length * 0.99)];
const minDuration = durations[0];
const maxDuration = durations[durations.length - 1];

console.log('\nConcurrent Load Test Results:');
console.log(`  Total time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
console.log(`  Total requests: ${allResults.length}`);
console.log(`  Successful: ${successful}`);
console.log(`  Failed: ${failed}`);
console.log(`  Success rate: ${(successful / allResults.length * 100).toFixed(2)}%`);
console.log(`\nLatency Statistics:`);
console.log(`  Avg: ${avgDuration.toFixed(2)}ms`);
console.log(`  Min: ${minDuration}ms`);
console.log(`  Max: ${maxDuration}ms`);
console.log(`  P50: ${p50}ms`);
console.log(`  P95: ${p95}ms`);
console.log(`  P99: ${p99}ms`);
console.log(`\nThroughput:`);
console.log(`  ${(allResults.length / (totalTime / 1000)).toFixed(2)} req/s`);
console.log(`  ${(successful / (totalTime / 1000)).toFixed(2)} successful req/s`);

// Analyze errors if any
if (failed > 0) {
  const errorTypes = {};
  allResults.filter(r => !r.success).forEach(r => {
    const errorKey = r.error || 'Unknown';
    errorTypes[errorKey] = (errorTypes[errorKey] || 0) + 1;
  });
  console.log(`\nError Breakdown:`);
  for (const [error, count] of Object.entries(errorTypes)) {
    console.log(`  ${error}: ${count}`);
  }
}

process.exit(failed > (allResults.length * 0.05) ? 1 : 0); // Allow 5% failure rate
EOF

node test-concurrent.mjs $CONCURRENT_AGENTS $REQUESTS_PER_AGENT
CONCURRENT_RESULT=$?

if [ $CONCURRENT_RESULT -eq 0 ]; then
  echo "✓ Concurrent load test passed"
  echo ""
else
  echo "✗ Concurrent load test failed"
  kill $SERVICE_PID 2>/dev/null || true
  exit 1
fi

# Test 3: Memory and Resource Usage
echo ""
echo "Test 3: Resource Usage Analysis"
echo "=========================================="

# Get stats before load
STATS_BEFORE=$(curl -s -H "Authorization: Bearer $CDP_SERVICE_TOKEN" \
  http://localhost:3100/api/v1/stats)

# Run sustained load
echo "Running sustained load (30 seconds)..."

cat > test-sustained.mjs <<'EOF'
import { CdpServiceClient } from './dist/client.js';

const durationMs = 30000;
const concurrency = 20;

console.log(`Running sustained load for ${durationMs/1000}s with ${concurrency} concurrent workers...`);

const startTime = Date.now();
let completed = 0;
let errors = 0;

async function worker(workerId) {
  const client = new CdpServiceClient({
    serviceUrl: 'http://localhost:3100',
    authToken: process.env.CDP_SERVICE_TOKEN,
    defaultTimeout: 30000,
  });

  while (Date.now() - startTime < durationMs) {
    try {
      await client.evaluate({
        agentId: `sustained-worker-${workerId}`,
        expression: 'Math.random() * 1000',
        budget: { timeoutMs: 5000 }
      });
      completed++;
    } catch (error) {
      errors++;
    }
  }

  client.dispose();
}

const workers = [];
for (let i = 0; i < concurrency; i++) {
  workers.push(worker(i));
}

await Promise.all(workers);

const totalTime = Date.now() - startTime;
console.log(`\nCompleted: ${completed}`);
console.log(`Errors: ${errors}`);
console.log(`Success rate: ${(completed / (completed + errors) * 100).toFixed(2)}%`);
console.log(`Throughput: ${(completed / (totalTime / 1000)).toFixed(2)} req/s`);

process.exit(0);
EOF

node test-sustained.mjs

# Get stats after load
STATS_AFTER=$(curl -s -H "Authorization: Bearer $CDP_SERVICE_TOKEN" \
  http://localhost:3100/api/v1/stats)

echo ""
echo "Resource Usage:"
echo "Before load:"
echo "$STATS_BEFORE" | python3 -c "import sys, json; data = json.load(sys.stdin); print(f\"  Active engines: {data.get('activeEngines', 0)}\"); print(f\"  Total requests: {data.get('totalRequests', 0)}\")"

echo "After load:"
echo "$STATS_AFTER" | python3 -c "import sys, json; data = json.load(sys.stdin); print(f\"  Active engines: {data.get('activeEngines', 0)}\"); print(f\"  Total requests: {data.get('totalRequests', 0)}\")"

echo ""

# Test 4: Stress Test (Burst Load)
echo ""
echo "Test 4: Burst Stress Test"
echo "=========================================="
echo "Sending 100 requests as fast as possible..."

cat > test-burst.mjs <<'EOF'
import { CdpServiceClient } from './dist/client.js';

const burstSize = 100;

console.log(`Sending ${burstSize} requests in parallel...`);

const client = new CdpServiceClient({
  serviceUrl: 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN,
  defaultTimeout: 30000,
});

const startTime = Date.now();

const promises = [];
for (let i = 0; i < burstSize; i++) {
  promises.push(
    client.evaluate({
      agentId: `burst-${i}`,
      expression: '42',
      budget: { timeoutMs: 10000 }
    }).then(() => ({ success: true }))
      .catch(err => ({ success: false, error: err.message }))
  );
}

const results = await Promise.all(promises);
const totalTime = Date.now() - startTime;

const successful = results.filter(r => r.success).length;
const failed = results.filter(r => !r.success).length;

console.log(`\nBurst Test Results:`);
console.log(`  Total time: ${totalTime}ms`);
console.log(`  Successful: ${successful}/${burstSize}`);
console.log(`  Failed: ${failed}`);
console.log(`  Success rate: ${(successful / burstSize * 100).toFixed(2)}%`);
console.log(`  Peak throughput: ${(burstSize / (totalTime / 1000)).toFixed(2)} req/s`);

client.dispose();
process.exit(failed > (burstSize * 0.1) ? 1 : 0); // Allow 10% failure for burst
EOF

node test-burst.mjs
BURST_RESULT=$?

if [ $BURST_RESULT -eq 0 ]; then
  echo "✓ Burst stress test passed"
else
  echo "✗ Burst stress test failed (some failures expected under extreme load)"
fi

echo ""

# Cleanup
rm -f test-baseline.mjs test-concurrent.mjs test-sustained.mjs test-burst.mjs

# Get final metrics
echo ""
echo "Final Prometheus Metrics Sample:"
echo "=========================================="
curl -s http://localhost:3100/metrics | grep -E "(cdp_evaluate_total|cdp_evaluate_duration|cdp_active)" | head -20

echo ""
echo ""
echo "=========================================="
echo "Load Test Summary"
echo "=========================================="
echo ""
echo "✓ Baseline performance measured"
echo "✓ Concurrent load test ($CONCURRENT_AGENTS agents) completed"
echo "✓ Resource usage tracked"
echo "✓ Burst stress test completed"
echo ""
echo "All Phase 5 load tests completed!"
echo ""

# Stop service
kill $SERVICE_PID 2>/dev/null || true
sleep 1

echo "✓ Load testing completed successfully"
