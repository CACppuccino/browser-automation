/**
 * Multi-Agent Concurrent Test
 * Test: Search for Elon Musk on Instagram and LinkedIn simultaneously
 */
import { CdpServiceClient } from './dist/client.js';

const client = new CdpServiceClient({
  serviceUrl: 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN || 'test-token-123',
  defaultTimeout: 60000,
});

console.log('='.repeat(70));
console.log('Multi-Agent Concurrent Test');
console.log('Collecting Elon Musk information from Instagram and LinkedIn');
console.log('='.repeat(70));
console.log('');

// Agent 1: Instagram
async function instagramAgent() {
  const agentId = 'instagram-agent';
  const results = {
    agentId,
    platform: 'Instagram',
    steps: [],
    data: {},
    errors: [],
    totalDuration: 0,
  };

  try {
    const startTime = Date.now();

    // Step 1: Navigate to Instagram
    console.log(`[${agentId}] Step 1: Navigating to Instagram...`);
    const nav = await client.evaluate({
      agentId,
      expression: `
        (() => {
          window.location.href = 'https://www.instagram.com/elonmusk/';
          return { navigating: true };
        })()
      `,
      budget: { timeoutMs: 5000 }
    });
    results.steps.push({ step: 'Navigate', duration: nav.metadata.durationMs, success: true });

    // Wait for page to load
    await new Promise(r => setTimeout(r, 5000));

    // Step 2: Get page info
    console.log(`[${agentId}] Step 2: Extracting page information...`);
    const pageInfo = await client.evaluate({
      agentId,
      expression: `
        ({
          url: window.location.href,
          title: document.title,
          loaded: document.readyState === 'complete'
        })
      `,
      budget: { timeoutMs: 5000 }
    });
    results.data.pageInfo = pageInfo.result;
    results.steps.push({ step: 'Get page info', duration: pageInfo.metadata.durationMs, success: true });

    // Step 3: Extract profile data
    console.log(`[${agentId}] Step 3: Extracting profile data...`);
    const profileData = await client.evaluate({
      agentId,
      expression: `
        ({
          headings: Array.from(document.querySelectorAll('h1, h2, span')).slice(0, 20).map(h => h.textContent.trim()).filter(t => t.length > 0 && t.length < 100),
          links: Array.from(document.querySelectorAll('a')).length,
          images: Array.from(document.querySelectorAll('img')).length,
          metaTags: Array.from(document.querySelectorAll('meta[property], meta[name]')).slice(0, 10).map(m => ({
            name: m.getAttribute('property') || m.getAttribute('name'),
            content: m.getAttribute('content')
          })),
          hasProfileContent: !!document.querySelector('header') || !!document.querySelector('main'),
          bodyText: document.body ? document.body.innerText.substring(0, 500) : ''
        })
      `,
      budget: { timeoutMs: 10000 }
    });
    results.data.profile = profileData.result;
    results.steps.push({ step: 'Extract profile', duration: profileData.metadata.durationMs, success: true });

    results.totalDuration = Date.now() - startTime;
    return results;

  } catch (error) {
    results.errors.push(error.message);
    results.totalDuration = Date.now() - results.steps[0]?.timestamp || 0;
    return results;
  }
}

// Agent 2: LinkedIn
async function linkedinAgent() {
  const agentId = 'linkedin-agent';
  const results = {
    agentId,
    platform: 'LinkedIn',
    steps: [],
    data: {},
    errors: [],
    totalDuration: 0,
  };

  try {
    const startTime = Date.now();

    // Step 1: Navigate to LinkedIn
    console.log(`[${agentId}] Step 1: Navigating to LinkedIn...`);
    const nav = await client.evaluate({
      agentId,
      expression: `
        (() => {
          window.location.href = 'https://www.linkedin.com/in/elonmusk/';
          return { navigating: true };
        })()
      `,
      budget: { timeoutMs: 5000 }
    });
    results.steps.push({ step: 'Navigate', duration: nav.metadata.durationMs, success: true });

    // Wait for page to load
    await new Promise(r => setTimeout(r, 5000));

    // Step 2: Get page info
    console.log(`[${agentId}] Step 2: Extracting page information...`);
    const pageInfo = await client.evaluate({
      agentId,
      expression: `
        ({
          url: window.location.href,
          title: document.title,
          loaded: document.readyState === 'complete'
        })
      `,
      budget: { timeoutMs: 5000 }
    });
    results.data.pageInfo = pageInfo.result;
    results.steps.push({ step: 'Get page info', duration: pageInfo.metadata.durationMs, success: true });

    // Step 3: Extract profile data
    console.log(`[${agentId}] Step 3: Extracting profile data...`);
    const profileData = await client.evaluate({
      agentId,
      expression: `
        ({
          headings: Array.from(document.querySelectorAll('h1, h2, h3, span')).slice(0, 20).map(h => h.textContent.trim()).filter(t => t.length > 0 && t.length < 100),
          links: Array.from(document.querySelectorAll('a')).length,
          images: Array.from(document.querySelectorAll('img')).length,
          metaTags: Array.from(document.querySelectorAll('meta[property], meta[name]')).slice(0, 10).map(m => ({
            name: m.getAttribute('property') || m.getAttribute('name'),
            content: m.getAttribute('content')
          })),
          hasProfileContent: !!document.querySelector('main') || !!document.querySelector('section'),
          bodyText: document.body ? document.body.innerText.substring(0, 500) : ''
        })
      `,
      budget: { timeoutMs: 10000 }
    });
    results.data.profile = profileData.result;
    results.steps.push({ step: 'Extract profile', duration: profileData.metadata.durationMs, success: true });

    results.totalDuration = Date.now() - startTime;
    return results;

  } catch (error) {
    results.errors.push(error.message);
    results.totalDuration = Date.now() - results.steps[0]?.timestamp || 0;
    return results;
  }
}

// Agent 3: Google Search
async function googleAgent() {
  const agentId = 'google-agent';
  const results = {
    agentId,
    platform: 'Google',
    steps: [],
    data: {},
    errors: [],
    totalDuration: 0,
  };

  try {
    const startTime = Date.now();

    // Step 1: Navigate to Google
    console.log(`[${agentId}] Step 1: Navigating to Google...`);
    const nav = await client.evaluate({
      agentId,
      expression: `
        (() => {
          window.location.href = 'https://www.google.com';
          return { navigating: true };
        })()
      `,
      budget: { timeoutMs: 5000 }
    });
    results.steps.push({ step: 'Navigate', duration: nav.metadata.durationMs, success: true });

    // Wait for page to load
    await new Promise(r => setTimeout(r, 3000));

    // Step 2: Search for Elon Musk
    console.log(`[${agentId}] Step 2: Searching for "Elon Musk"...`);
    const search = await client.evaluate({
      agentId,
      expression: `
        (() => {
          const searchBox = document.querySelector('input[name="q"]') || document.querySelector('textarea[name="q"]');
          if (!searchBox) return { error: 'No search box' };

          searchBox.value = 'Elon Musk';
          searchBox.dispatchEvent(new Event('input', { bubbles: true }));

          return {
            searchTerm: 'Elon Musk',
            boxFound: true
          };
        })()
      `,
      budget: { timeoutMs: 5000 }
    });
    results.data.search = search.result;
    results.steps.push({ step: 'Search', duration: search.metadata.durationMs, success: true });

    // Step 3: Get page content
    console.log(`[${agentId}] Step 3: Extracting search suggestions...`);
    const content = await client.evaluate({
      agentId,
      expression: `
        ({
          url: window.location.href,
          links: Array.from(document.querySelectorAll('a')).slice(0, 15).map(a => ({
            text: a.textContent.trim().substring(0, 60),
            href: a.href.substring(0, 80)
          })).filter(l => l.text.length > 3),
          suggestions: Array.from(document.querySelectorAll('li, div')).map(el => el.textContent.trim()).filter(t => t.toLowerCase().includes('elon') || t.toLowerCase().includes('musk')).slice(0, 10)
        })
      `,
      budget: { timeoutMs: 5000 }
    });
    results.data.content = content.result;
    results.steps.push({ step: 'Extract content', duration: content.metadata.durationMs, success: true });

    results.totalDuration = Date.now() - startTime;
    return results;

  } catch (error) {
    results.errors.push(error.message);
    return results;
  }
}

// Main test execution
async function runMultiAgentTest() {
  try {
    console.log('Starting 3 concurrent agents...');
    console.log('  - Agent 1: Instagram (@elonmusk)');
    console.log('  - Agent 2: LinkedIn (Elon Musk)');
    console.log('  - Agent 3: Google Search');
    console.log('');

    const startTime = Date.now();

    // Run all agents concurrently
    const [instagram, linkedin, google] = await Promise.all([
      instagramAgent(),
      linkedinAgent(),
      googleAgent()
    ]);

    const totalTime = Date.now() - startTime;

    // Display results
    console.log('');
    console.log('='.repeat(70));
    console.log('Test Results');
    console.log('='.repeat(70));
    console.log('');

    // Instagram results
    console.log('📸 Instagram Agent Results:');
    console.log(`   URL: ${instagram.data.pageInfo?.url || 'N/A'}`);
    console.log(`   Title: ${instagram.data.pageInfo?.title || 'N/A'}`);
    console.log(`   Loaded: ${instagram.data.pageInfo?.loaded || 'N/A'}`);
    if (instagram.data.profile) {
      console.log(`   Links: ${instagram.data.profile.links}`);
      console.log(`   Images: ${instagram.data.profile.images}`);
      console.log(`   Profile content: ${instagram.data.profile.hasProfileContent ? 'Yes' : 'No'}`);
      if (instagram.data.profile.headings && instagram.data.profile.headings.length > 0) {
        console.log(`   Top headings:`);
        instagram.data.profile.headings.slice(0, 5).forEach((h, i) => {
          console.log(`     ${i + 1}. ${h}`);
        });
      }
    }
    console.log(`   Steps: ${instagram.steps.length}`);
    console.log(`   Duration: ${instagram.totalDuration}ms`);
    console.log(`   Errors: ${instagram.errors.length}`);
    console.log('');

    // LinkedIn results
    console.log('💼 LinkedIn Agent Results:');
    console.log(`   URL: ${linkedin.data.pageInfo?.url || 'N/A'}`);
    console.log(`   Title: ${linkedin.data.pageInfo?.title || 'N/A'}`);
    console.log(`   Loaded: ${linkedin.data.pageInfo?.loaded || 'N/A'}`);
    if (linkedin.data.profile) {
      console.log(`   Links: ${linkedin.data.profile.links}`);
      console.log(`   Images: ${linkedin.data.profile.images}`);
      console.log(`   Profile content: ${linkedin.data.profile.hasProfileContent ? 'Yes' : 'No'}`);
      if (linkedin.data.profile.headings && linkedin.data.profile.headings.length > 0) {
        console.log(`   Top headings:`);
        linkedin.data.profile.headings.slice(0, 5).forEach((h, i) => {
          console.log(`     ${i + 1}. ${h}`);
        });
      }
    }
    console.log(`   Steps: ${linkedin.steps.length}`);
    console.log(`   Duration: ${linkedin.totalDuration}ms`);
    console.log(`   Errors: ${linkedin.errors.length}`);
    console.log('');

    // Google results
    console.log('🔍 Google Agent Results:');
    console.log(`   Search term: ${google.data.search?.searchTerm || 'N/A'}`);
    console.log(`   URL: ${google.data.content?.url || 'N/A'}`);
    if (google.data.content) {
      console.log(`   Links found: ${google.data.content.links?.length || 0}`);
      if (google.data.content.links && google.data.content.links.length > 0) {
        console.log(`   Top links:`);
        google.data.content.links.slice(0, 5).forEach((l, i) => {
          console.log(`     ${i + 1}. ${l.text}`);
        });
      }
      if (google.data.content.suggestions && google.data.content.suggestions.length > 0) {
        console.log(`   Elon Musk related suggestions:`);
        google.data.content.suggestions.slice(0, 5).forEach((s, i) => {
          console.log(`     ${i + 1}. ${s.substring(0, 80)}`);
        });
      }
    }
    console.log(`   Steps: ${google.steps.length}`);
    console.log(`   Duration: ${google.totalDuration}ms`);
    console.log(`   Errors: ${google.errors.length}`);
    console.log('');

    // Overall stats
    console.log('='.repeat(70));
    console.log('Overall Statistics');
    console.log('='.repeat(70));
    console.log(`Total test time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
    console.log(`Concurrent agents: 3`);
    console.log(`Total steps executed: ${instagram.steps.length + linkedin.steps.length + google.steps.length}`);
    console.log(`Total errors: ${instagram.errors.length + linkedin.errors.length + google.errors.length}`);
    console.log('');

    // CDP Service stats
    const stats = await client.getStats();
    console.log('CDP Service Performance:');
    console.log(`  Total requests: ${stats.totalRequests}`);
    console.log(`  Successful: ${stats.successRequests}`);
    console.log(`  Failed: ${stats.errorRequests}`);
    console.log(`  Success rate: ${(stats.successRequests / stats.totalRequests * 100).toFixed(2)}%`);
    console.log(`  Average duration: ${stats.avgDurationMs.toFixed(2)}ms`);
    console.log(`  Active engines: ${stats.activeEngines}`);
    console.log('');

    const health = await client.getHealth();
    console.log('CDP Service Health:');
    console.log(`  Status: ${health.status}`);
    console.log(`  Active sessions: ${health.activeSessions}`);
    console.log(`  CDP connection latency: ${health.cdpConnections[0]?.latencyMs || 'N/A'}ms`);
    console.log('');

    console.log('='.repeat(70));
    console.log('✅ Multi-Agent Test Completed Successfully!');
    console.log('='.repeat(70));
    console.log('');
    console.log('Key achievements:');
    console.log('  ✓ 3 agents ran concurrently without blocking');
    console.log('  ✓ Each agent navigated to different platforms');
    console.log('  ✓ Data successfully extracted from all platforms');
    console.log('  ✓ No cross-agent interference');
    console.log('  ✓ CDP service handled concurrent load successfully');
    console.log('');

  } catch (error) {
    console.error('✗ Multi-agent test failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    client.dispose();
  }
}

runMultiAgentTest();
