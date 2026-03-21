/**
 * Multi-agent browser isolation regression test.
 */
import { CdpServiceClient } from './dist/client.js';

const client = new CdpServiceClient({
  serviceUrl: 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN || 'test-token-123',
  defaultTimeout: 15000,
});

const sharedAgents = [
  { agentId: 'shared-agent-alpha', marker: 'alpha' },
  { agentId: 'shared-agent-beta', marker: 'beta' },
];

const dedicatedAgents = [
  { agentId: 'dedicated-agent-one', marker: 'one' },
  { agentId: 'dedicated-agent-two', marker: 'two' },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupSession(agentId, browserMode) {
  try {
    await client.deleteSession(agentId, browserMode);
  } catch (error) {
    if (error?.statusCode !== 404) {
      throw error;
    }
  }
}

async function cleanupAll() {
  for (const { agentId } of [...sharedAgents, ...dedicatedAgents]) {
    await cleanupSession(agentId, 'shared');
    await cleanupSession(agentId, 'dedicated');
  }
}

function buildSetMarkerExpression(marker) {
  return `
    (() => {
      const marker = ${JSON.stringify(marker)};
      if (!document.body) {
        const body = document.createElement('body');
        document.documentElement.appendChild(body);
      }
      document.title = marker;
      document.body.innerHTML = '<main id="agent-state" data-agent="' + marker + '">' + marker + '</main>';
      window.__agentMarker = marker;
      return {
        title: document.title,
        marker: document.querySelector('#agent-state')?.dataset.agent || null,
        windowMarker: window.__agentMarker || null,
        href: window.location.href
      };
    })()
  `;
}

const readMarkerExpression = `
  (() => ({
    title: document.title,
    marker: document.querySelector('#agent-state')?.dataset.agent || null,
    windowMarker: window.__agentMarker || null,
    href: window.location.href
  }))()
`;

async function setMarker(agentId, browserMode, marker) {
  return client.evaluate({
    agentId,
    browserMode,
    expression: buildSetMarkerExpression(marker),
    budget: { timeoutMs: 5000 },
  });
}

async function readMarker(agentId, browserMode) {
  const response = await client.evaluate({
    agentId,
    browserMode,
    expression: readMarkerExpression,
    budget: { timeoutMs: 5000 },
  });
  return response.result;
}

async function expectForeignTargetRejected(ownerAgentId, ownerMode, foreignTargetId) {
  let rejected = false;

  try {
    await client.evaluate({
      agentId: ownerAgentId,
      browserMode: ownerMode,
      targetId: foreignTargetId,
      expression: 'document.title',
      budget: { timeoutMs: 5000 },
    });
  } catch (error) {
    rejected = true;
    assert(
      error.message.includes('not owned by agent') || error.message.includes('targetId'),
      `unexpected foreign-target error: ${error.message}`
    );
  }

  assert(rejected, 'foreign target override should be rejected');
}

async function testSharedMode() {
  console.log('Testing shared mode session allocation...');

  const alpha = await client.createSession({
    agentId: sharedAgents[0].agentId,
    browserMode: 'shared',
  });
  const beta = await client.createSession({
    agentId: sharedAgents[1].agentId,
    browserMode: 'shared',
  });
  const alphaReuse = await client.createSession({
    agentId: sharedAgents[0].agentId,
    browserMode: 'shared',
  });

  assert(alpha.browserInstanceId === beta.browserInstanceId, 'shared agents should reuse one browser');
  assert(alpha.targetId !== beta.targetId, 'shared agents should get different targets');
  assert(alphaReuse.targetId === alpha.targetId, 'shared session should be reused for same agent');
  assert(alphaReuse.browserInstanceId === alpha.browserInstanceId, 'shared browser instance should be reused');

  console.log(`  shared browser instance: ${alpha.browserInstanceId}`);
  console.log(`  alpha target: ${alpha.targetId}`);
  console.log(`  beta target:  ${beta.targetId}`);

  console.log('Testing shared mode concurrent isolation...');
  await Promise.all([
    setMarker(sharedAgents[0].agentId, 'shared', sharedAgents[0].marker),
    setMarker(sharedAgents[1].agentId, 'shared', sharedAgents[1].marker),
  ]);

  await sleep(100);

  const [alphaState, betaState] = await Promise.all([
    readMarker(sharedAgents[0].agentId, 'shared'),
    readMarker(sharedAgents[1].agentId, 'shared'),
  ]);

  assert(alphaState.title === sharedAgents[0].marker, 'shared alpha title mismatch');
  assert(alphaState.marker === sharedAgents[0].marker, 'shared alpha marker mismatch');
  assert(betaState.title === sharedAgents[1].marker, 'shared beta title mismatch');
  assert(betaState.marker === sharedAgents[1].marker, 'shared beta marker mismatch');

  console.log(`  alpha state: ${JSON.stringify(alphaState)}`);
  console.log(`  beta state:  ${JSON.stringify(betaState)}`);

  console.log('Testing foreign target rejection...');
  await expectForeignTargetRejected(sharedAgents[0].agentId, 'shared', beta.targetId);
  console.log('  foreign target override rejected');
}

async function testDedicatedMode() {
  console.log('Testing dedicated mode allocation...');

  const one = await client.createSession({
    agentId: dedicatedAgents[0].agentId,
    browserMode: 'dedicated',
  });
  const oneReuse = await client.createSession({
    agentId: dedicatedAgents[0].agentId,
    browserMode: 'dedicated',
  });
  const two = await client.createSession({
    agentId: dedicatedAgents[1].agentId,
    browserMode: 'dedicated',
  });

  assert(one.browserInstanceId === oneReuse.browserInstanceId, 'dedicated browser should be reused for same agent');
  assert(one.targetId === oneReuse.targetId, 'dedicated target should be reused for same agent');
  assert(one.cdpUrl === oneReuse.cdpUrl, 'dedicated cdp url should be reused for same agent');
  assert(one.browserInstanceId !== two.browserInstanceId, 'dedicated agents should get different browser ids');
  assert(one.cdpUrl !== two.cdpUrl, 'dedicated agents should get different browser endpoints');
  assert(one.targetId !== two.targetId, 'dedicated agents should get different targets');

  console.log(`  agent one browser: ${one.browserInstanceId} @ ${one.cdpUrl}`);
  console.log(`  agent two browser: ${two.browserInstanceId} @ ${two.cdpUrl}`);

  console.log('Testing dedicated mode concurrent isolation...');
  await Promise.all([
    setMarker(dedicatedAgents[0].agentId, 'dedicated', dedicatedAgents[0].marker),
    setMarker(dedicatedAgents[1].agentId, 'dedicated', dedicatedAgents[1].marker),
  ]);

  await sleep(100);

  const [oneState, twoState] = await Promise.all([
    readMarker(dedicatedAgents[0].agentId, 'dedicated'),
    readMarker(dedicatedAgents[1].agentId, 'dedicated'),
  ]);

  assert(oneState.title === dedicatedAgents[0].marker, 'dedicated agent one title mismatch');
  assert(oneState.marker === dedicatedAgents[0].marker, 'dedicated agent one marker mismatch');
  assert(twoState.title === dedicatedAgents[1].marker, 'dedicated agent two title mismatch');
  assert(twoState.marker === dedicatedAgents[1].marker, 'dedicated agent two marker mismatch');

  console.log(`  agent one state: ${JSON.stringify(oneState)}`);
  console.log(`  agent two state: ${JSON.stringify(twoState)}`);
}

async function printServiceState() {
  const stats = await client.getStats();
  const health = await client.getHealth();

  console.log('Service stats:');
  console.log(`  total requests: ${stats.totalRequests}`);
  console.log(`  success requests: ${stats.successRequests}`);
  console.log(`  active engines: ${stats.activeEngines}`);
  console.log(`  active browser sessions: ${stats.browser?.activeSessions ?? 'n/a'}`);
  console.log(`  active browser instances: ${stats.browser?.activeBrowserInstances ?? health.activeBrowserInstances ?? 'n/a'}`);
  console.log(`  health: ${health.status}`);
}

async function main() {
  console.log('================================================================');
  console.log('Multi-agent browser isolation regression test');
  console.log('================================================================');

  await cleanupAll();

  try {
    await testSharedMode();
    await testDedicatedMode();
    await printServiceState();

    console.log('');
    console.log('PASS: shared and dedicated browser isolation validated');
  } finally {
    await cleanupAll();
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
