/**
 * Browser session reuse smoke test.
 */
import { CdpServiceClient } from './dist/client.js';

const client = new CdpServiceClient({
  serviceUrl: 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN || 'test-token-123',
  defaultTimeout: 15000,
});

const sharedAgentId = 'browser-test-shared';
const dedicatedAgentId = 'browser-test-dedicated';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function cleanup() {
  for (const [agentId, mode] of [
    [sharedAgentId, 'shared'],
    [dedicatedAgentId, 'dedicated'],
  ]) {
    try {
      await client.deleteSession(agentId, mode);
    } catch (error) {
      if (error?.statusCode !== 404) {
        throw error;
      }
    }
  }
}

async function testSharedReuse() {
  console.log('Step 1: Creating shared session...');
  const created = await client.createSession({
    agentId: sharedAgentId,
    browserMode: 'shared',
  });

  console.log(`  browser: ${created.browserInstanceId}`);
  console.log(`  target:  ${created.targetId}`);

  console.log('Step 2: Writing marker into shared page...');
  const write = await client.evaluate({
    agentId: sharedAgentId,
    browserMode: 'shared',
    expression: `
      (() => {
        document.title = 'shared-session-marker';
        document.body.innerHTML = '<main id="session-check">shared-session-marker</main>';
        window.__sessionCheck = 'shared-session-marker';
        return {
          title: document.title,
          marker: document.querySelector('#session-check')?.textContent || null,
          windowMarker: window.__sessionCheck || null
        };
      })()
    `,
    budget: { timeoutMs: 5000 },
  });

  console.log(`  write duration: ${write.metadata.durationMs}ms`);

  console.log('Step 3: Recreating shared session and validating reuse...');
  const reused = await client.createSession({
    agentId: sharedAgentId,
    browserMode: 'shared',
  });

  assert(reused.browserInstanceId === created.browserInstanceId, 'shared browser instance should be reused');
  assert(reused.targetId === created.targetId, 'shared target should be reused');

  const read = await client.evaluate({
    agentId: sharedAgentId,
    browserMode: 'shared',
    expression: `
      (() => ({
        title: document.title,
        marker: document.querySelector('#session-check')?.textContent || null,
        windowMarker: window.__sessionCheck || null
      }))()
    `,
    budget: { timeoutMs: 5000 },
  });

  assert(read.result.title === 'shared-session-marker', 'shared title should persist');
  assert(read.result.marker === 'shared-session-marker', 'shared DOM marker should persist');
  assert(read.result.windowMarker === 'shared-session-marker', 'shared window marker should persist');

  console.log(`  reused browser: ${reused.browserInstanceId}`);
  console.log(`  reused target:  ${reused.targetId}`);
  console.log(`  read state:     ${JSON.stringify(read.result)}`);
}

async function testDedicatedMetadata() {
  console.log('Step 4: Creating dedicated session...');
  const dedicated = await client.createSession({
    agentId: dedicatedAgentId,
    browserMode: 'dedicated',
  });

  console.log(`  browser: ${dedicated.browserInstanceId}`);
  console.log(`  target:  ${dedicated.targetId}`);
  console.log(`  cdpUrl:  ${dedicated.cdpUrl}`);

  console.log('Step 5: Validating dedicated evaluation metadata...');
  const result = await client.evaluate({
    agentId: dedicatedAgentId,
    browserMode: 'dedicated',
    expression: `({ href: window.location.href, title: document.title })`,
    budget: { timeoutMs: 5000 },
  });

  assert(result.metadata.browserMode === 'dedicated', 'dedicated browserMode metadata mismatch');
  assert(
    result.metadata.browserInstanceId === dedicated.browserInstanceId,
    'dedicated browserInstanceId metadata mismatch'
  );
  assert(result.metadata.targetId === dedicated.targetId, 'dedicated targetId metadata mismatch');

  console.log(`  metadata: ${JSON.stringify(result.metadata)}`);
}

async function printServiceState() {
  const stats = await client.getStats();
  const health = await client.getHealth();

  console.log('Step 6: Service state...');
  console.log(`  total requests: ${stats.totalRequests}`);
  console.log(`  success requests: ${stats.successRequests}`);
  console.log(`  active sessions: ${health.activeSessions}`);
  console.log(`  active browser instances: ${health.activeBrowserInstances ?? 'n/a'}`);
  for (const connection of health.cdpConnections) {
    console.log(`  cdp: ${connection.url} -> ${connection.status}${connection.latencyMs ? ` (${connection.latencyMs}ms)` : ''}`);
  }
}

async function main() {
  console.log('============================================================');
  console.log('Browser session reuse smoke test');
  console.log('============================================================');

  await cleanup();

  try {
    await testSharedReuse();
    await testDedicatedMetadata();
    await printServiceState();
    console.log('');
    console.log('PASS: browser session reuse validated');
  } finally {
    await cleanup();
    client.dispose();
  }
}

main().catch((error) => {
  console.error('FAIL:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
