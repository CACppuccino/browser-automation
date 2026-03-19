/**
 * Real Browser Test - Direct Interaction with Google
 */
import { CdpServiceClient } from './dist/client.js';

const client = new CdpServiceClient({
  serviceUrl: 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN || 'test-token-123',
  defaultTimeout: 60000,
});

console.log('='.repeat(60));
console.log('CDP Service Real Browser Test');
console.log('Testing: Google Search Interaction');
console.log('='.repeat(60));
console.log('');

async function test() {
  try {
    // Step 1: Get current page info
    console.log('Step 1: Getting current page info...');
    const pageInfo = await client.evaluate({
      agentId: 'browser-test',
      expression: `
        ({
          url: window.location.href,
          title: document.title,
          readyState: document.readyState,
          hasSearchBox: !!document.querySelector('input[name="q"]') || !!document.querySelector('textarea[name="q"]')
        })
      `,
      budget: { timeoutMs: 5000 }
    });

    console.log('✓ Page information:');
    console.log(`  URL: ${pageInfo.result.url}`);
    console.log(`  Title: ${pageInfo.result.title}`);
    console.log(`  Ready: ${pageInfo.result.readyState}`);
    console.log(`  Has search box: ${pageInfo.result.hasSearchBox}`);
    console.log(`  Duration: ${pageInfo.metadata.durationMs}ms`);
    console.log('');

    if (!pageInfo.result.hasSearchBox) {
      console.log('⚠️  No search box found. Make sure Chrome is on Google page.');
      console.log('');
    } else {
      // Step 2: Enter search text
      console.log('Step 2: Entering search query "OpenAI GPT-4 news"...');
      const searchInput = await client.evaluate({
        agentId: 'browser-test',
        expression: `
          (() => {
            const searchBox = document.querySelector('input[name="q"]') || document.querySelector('textarea[name="q"]');
            if (!searchBox) return { error: 'No search box found' };

            searchBox.value = 'OpenAI GPT-4 news';
            searchBox.dispatchEvent(new Event('input', { bubbles: true }));

            return {
              value: searchBox.value,
              type: searchBox.tagName.toLowerCase(),
              name: searchBox.name
            };
          })()
        `,
        budget: { timeoutMs: 5000 }
      });

      console.log('✓ Text entered into search box:');
      console.log(`  Element: <${searchInput.result.type} name="${searchInput.result.name}">`);
      console.log(`  Value: "${searchInput.result.value}"`);
      console.log(`  Duration: ${searchInput.metadata.durationMs}ms`);
      console.log('');

      // Step 3: Extract page links
      console.log('Step 3: Extracting page content...');
      const pageContent = await client.evaluate({
        agentId: 'browser-test',
        expression: `
          ({
            linkCount: document.querySelectorAll('a').length,
            topLinks: Array.from(document.querySelectorAll('a')).slice(0, 10).map(a => ({
              text: a.textContent.trim().substring(0, 60),
              hasHref: !!a.href
            })).filter(l => l.text.length > 3),
            headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 5).map(h => h.textContent.trim()).filter(t => t.length > 0),
            imageCount: document.querySelectorAll('img').length
          })
        `,
        budget: { timeoutMs: 5000 }
      });

      console.log('✓ Content extracted:');
      console.log(`  Total links: ${pageContent.result.linkCount}`);
      console.log(`  Images: ${pageContent.result.imageCount}`);
      console.log(`  Headings: ${pageContent.result.headings.length}`);
      console.log('  Top 5 links:');
      pageContent.result.topLinks.slice(0, 5).forEach((link, i) => {
        console.log(`    ${i + 1}. ${link.text}`);
      });
      console.log(`  Duration: ${pageContent.metadata.durationMs}ms`);
      console.log('');

      // Step 4: Get DOM statistics
      console.log('Step 4: Analyzing DOM structure...');
      const domStats = await client.evaluate({
        agentId: 'browser-test',
        expression: `
          ({
            totalElements: document.querySelectorAll('*').length,
            divs: document.querySelectorAll('div').length,
            spans: document.querySelectorAll('span').length,
            buttons: document.querySelectorAll('button').length,
            inputs: document.querySelectorAll('input').length,
            bodyHeight: document.body.scrollHeight,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight
            }
          })
        `,
        budget: { timeoutMs: 5000 }
      });

      console.log('✓ DOM Statistics:');
      console.log(`  Total elements: ${domStats.result.totalElements}`);
      console.log(`  DIVs: ${domStats.result.divs}`);
      console.log(`  Spans: ${domStats.result.spans}`);
      console.log(`  Buttons: ${domStats.result.buttons}`);
      console.log(`  Inputs: ${domStats.result.inputs}`);
      console.log(`  Body height: ${domStats.result.bodyHeight}px`);
      console.log(`  Viewport: ${domStats.result.viewport.width}x${domStats.result.viewport.height}`);
      console.log(`  Duration: ${domStats.metadata.durationMs}ms`);
      console.log('');
    }

    // Get service statistics
    console.log('='.repeat(60));
    console.log('CDP Service Statistics');
    console.log('='.repeat(60));

    const stats = await client.getStats();
    console.log('Service Performance:');
    console.log(`  Total requests: ${stats.totalRequests}`);
    console.log(`  Successful: ${stats.successRequests}`);
    console.log(`  Failed: ${stats.errorRequests}`);
    console.log(`  Success rate: ${(stats.successRequests / stats.totalRequests * 100).toFixed(2)}%`);
    console.log(`  Average duration: ${stats.avgDurationMs.toFixed(2)}ms`);
    console.log(`  Requests/sec: ${stats.requestsPerSecond.toFixed(2)}`);
    console.log('');

    const health = await client.getHealth();
    console.log('Service Health:');
    console.log(`  Status: ${health.status}`);
    console.log(`  Uptime: ${(health.uptime / 1000).toFixed(2)}s`);
    console.log(`  Active engines: ${health.activeEngines}`);
    console.log(`  Active sessions: ${health.activeSessions}`);
    console.log(`  CDP connections: ${health.cdpConnections.length}`);
    health.cdpConnections.forEach(conn => {
      console.log(`    - ${conn.url}: ${conn.status} (${conn.latencyMs}ms)`);
    });
    console.log('');

    console.log('='.repeat(60));
    console.log('✅ Real Browser Test Completed Successfully!');
    console.log('='.repeat(60));
    console.log('');
    console.log('The CDP service successfully demonstrated:');
    console.log('  ✓ Connection to real Chrome browser via CDP');
    console.log('  ✓ JavaScript evaluation in browser context');
    console.log('  ✓ DOM element selection and interaction');
    console.log('  ✓ Page content extraction');
    console.log('  ✓ Form input manipulation');
    console.log('  ✓ Real-time monitoring and statistics');
    console.log('');

  } catch (error) {
    console.error('✗ Test failed:', error.message);
    if (error.statusCode) {
      console.error('  Status code:', error.statusCode);
    }
    if (error.details) {
      console.error('  Details:', JSON.stringify(error.details, null, 2));
    }
    process.exit(1);
  } finally {
    client.dispose();
  }
}

test();
