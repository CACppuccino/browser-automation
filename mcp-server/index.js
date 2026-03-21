#!/usr/bin/env node
/**
 * OpenClaw Browser Automation MCP Server
 *
 * This server implements the Model Context Protocol (MCP) for browser automation,
 * providing AI models like Claude with standardized browser control capabilities.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

class CdpServiceClient {
  constructor(options) {
    this.serviceUrl = options.serviceUrl;
    this.authToken = options.authToken;
    this.defaultTimeout = options.defaultTimeout || 30000;
  }

  async evaluate(params) {
    const response = await fetch(`${this.serviceUrl}/api/v1/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({
        agentId: params.agentId || 'mcp-agent',
        browserMode: params.browserMode,
        expression: params.expression,
        awaitPromise: params.awaitPromise !== false,
        returnByValue: params.returnByValue !== false,
        budget: {
          timeoutMs: params.budget?.timeoutMs || this.defaultTimeout,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`CDP Service error: ${error.message || error.error || response.statusText}`);
    }

    return response.json();
  }

  async getHealth() {
    const response = await fetch(`${this.serviceUrl}/health`);
    return response.json();
  }

  async getStats() {
    const response = await fetch(`${this.serviceUrl}/api/v1/stats`, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });
    return response.json();
  }
}

const cdpClient = new CdpServiceClient({
  serviceUrl: process.env.CDP_SERVICE_URL || 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN || 'test-token-123',
  defaultTimeout: 30000,
});

const server = new Server(
  {
    name: 'openclaw-browser',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const browserModeProperty = {
  type: 'string',
  enum: ['shared', 'dedicated'],
  description: 'Browser ownership mode: shared Chrome or dedicated per-agent Chrome',
};

const TOOLS = [
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript code in the browser context. Returns the evaluation result.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'JavaScript code to execute in the browser',
        },
        agentId: {
          type: 'string',
          description: "Optional agent identifier for session isolation (default: 'mcp-agent')",
        },
        browserMode: browserModeProperty,
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
        awaitPromise: {
          type: 'boolean',
          description: 'Whether to await Promise results (default: true)',
        },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the browser to a specific URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to',
        },
        agentId: {
          type: 'string',
          description: "Optional agent identifier (default: 'mcp-agent')",
        },
        browserMode: browserModeProperty,
        waitForLoad: {
          type: 'boolean',
          description: 'Wait for page load completion (default: true)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the page by CSS selector',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the element to click',
        },
        agentId: {
          type: 'string',
          description: 'Optional agent identifier',
        },
        browserMode: browserModeProperty,
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_fill',
    description: 'Fill an input field with text',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the input field',
        },
        value: {
          type: 'string',
          description: 'Text value to fill',
        },
        agentId: {
          type: 'string',
          description: 'Optional agent identifier',
        },
        browserMode: browserModeProperty,
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Get a snapshot of the current page state (HTML, URL, cookies)',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Optional agent identifier',
        },
        browserMode: browserModeProperty,
        includeHtml: {
          type: 'boolean',
          description: 'Include full HTML (default: true)',
        },
        includeCookies: {
          type: 'boolean',
          description: 'Include cookies (default: true)',
        },
      },
    },
  },
  {
    name: 'browser_extract',
    description: 'Extract data from the page using CSS selectors',
    inputSchema: {
      type: 'object',
      properties: {
        selectors: {
          type: 'object',
          description: 'Map of field names to CSS selectors',
          additionalProperties: {
            type: 'string',
          },
        },
        agentId: {
          type: 'string',
          description: 'Optional agent identifier',
        },
        browserMode: browserModeProperty,
      },
      required: ['selectors'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for an element to appear or a condition to be met',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to wait for (optional if condition is provided)',
        },
        condition: {
          type: 'string',
          description: 'JavaScript expression that should evaluate to true (optional)',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum wait time in milliseconds (default: 30000)',
        },
        agentId: {
          type: 'string',
          description: 'Optional agent identifier',
        },
        browserMode: browserModeProperty,
      },
    },
  },
  {
    name: 'browser_health',
    description: 'Check the health status of the CDP service',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

function literal(value) {
  return JSON.stringify(String(value));
}

function buildStartNavigateExpression(url) {
  const serializedUrl = literal(url);
  return `
    (() => {
      const nextUrl = ${serializedUrl};
      window.setTimeout(() => {
        window.location.href = nextUrl;
      }, 0);
      return {
        scheduled: true,
        requestedUrl: nextUrl,
        previousUrl: window.location.href
      };
    })()
  `;
}

function buildPageStateExpression() {
  return `
    ({
      url: window.location.href,
      title: document.title,
      readyState: document.readyState
    })
  `;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeComparablePath(pathname) {
  if (!pathname || pathname === '/') {
    return '/';
  }

  return pathname.endsWith('/') ? pathname.slice(0, -1) || '/' : pathname;
}

function urlMatchesTarget(currentUrl, requestedUrl) {
  if (currentUrl === requestedUrl || currentUrl.startsWith(requestedUrl)) {
    return true;
  }

  try {
    const current = new URL(currentUrl);
    const requested = new URL(requestedUrl);

    if (current.origin !== requested.origin) {
      return false;
    }

    const currentPath = normalizeComparablePath(current.pathname);
    const requestedPath = normalizeComparablePath(requested.pathname);

    if (requestedPath === '/') {
      return true;
    }

    return currentPath === requestedPath;
  } catch {
    return currentUrl === requestedUrl;
  }
}

function isTransientEvaluationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'Execution context was destroyed',
    'Cannot find context with specified id',
    'Inspected target navigated or closed',
    'No frame with given id',
    'Target closed',
    'Session closed',
    'CDP Service error: Uncaught',
    'Error: Uncaught',
  ].some((pattern) => message.includes(pattern));
}

function buildClickExpression(selector) {
  const serializedSelector = literal(selector);
  return `
    (() => {
      const element = document.querySelector(${serializedSelector});
      if (!element) {
        throw new Error('Element not found for selector: ' + ${serializedSelector});
      }
      element.click();
      return { clicked: true, selector: ${serializedSelector} };
    })()
  `;
}

function buildFillExpression(selector, value) {
  const serializedSelector = literal(selector);
  const serializedValue = literal(value);
  return `
    (() => {
      const element = document.querySelector(${serializedSelector});
      if (!element) {
        throw new Error('Element not found for selector: ' + ${serializedSelector});
      }
      element.value = ${serializedValue};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { selector: ${serializedSelector}, value: element.value };
    })()
  `;
}

function buildSnapshotExpression(includeHtml, includeCookies) {
  return `
    ({
      url: window.location.href,
      title: document.title,
      ${includeHtml !== false ? 'html: document.documentElement.outerHTML,' : ''}
      ${includeCookies !== false ? 'cookies: document.cookie,' : ''}
      readyState: document.readyState
    })
  `;
}

function buildExtractExpression(selectors) {
  const fields = Object.entries(selectors || {}).map(([key, selector]) => {
    return `${JSON.stringify(key)}: document.querySelector(${literal(selector)})?.textContent?.trim() || null`;
  });

  return `({
    ${fields.join(',\n    ')}
  })`;
}

function buildWaitExpression(args) {
  const timeoutMs = args.timeoutMs || 30000;

  if (args.selector) {
    const serializedSelector = literal(args.selector);
    return `
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for selector')), ${timeoutMs});
        const check = () => {
          if (document.querySelector(${serializedSelector})) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
      ({ selector: ${serializedSelector}, met: true });
    `;
  }

  if (args.condition) {
    return `
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for condition')), ${timeoutMs});
        const check = () => {
          if (${args.condition}) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
      ({ conditionMet: true });
    `;
  }

  throw new Error('Either selector or condition must be provided');
}

async function evaluateWithBrowserMode(args, expression, timeoutMs, extra = {}) {
  return cdpClient.evaluate({
    agentId: args.agentId,
    browserMode: args.browserMode,
    expression,
    budget: { timeoutMs: timeoutMs || cdpClient.defaultTimeout },
    ...extra,
  });
}

async function waitForNavigationResult(args, requestedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  let transientFailures = 0;

  while (Date.now() < deadline) {
    try {
      const snapshot = await evaluateWithBrowserMode(
        args,
        buildPageStateExpression(),
        Math.max(1000, Math.min(5000, deadline - Date.now())),
        {
          awaitPromise: false,
        }
      );
      lastState = snapshot.result;

      if (
        lastState &&
        typeof lastState.url === 'string' &&
        urlMatchesTarget(lastState.url, requestedUrl) &&
        lastState.readyState === 'complete'
      ) {
        return lastState;
      }
    } catch (error) {
      if (!isTransientEvaluationError(error)) {
        throw error;
      }
      transientFailures += 1;
    }

    await sleep(250);
  }

  const details = lastState ? ` Last state: ${JSON.stringify(lastState)}` : '';
  const transientNote = transientFailures > 0 ? ` Transient errors: ${transientFailures}.` : '';
  throw new Error(`Navigation timeout waiting for ${requestedUrl}.${transientNote}${details}`);
}

async function navigateWithBrowserMode(args) {
  const requestedUrl = String(args.url);
  const timeoutMs = 10000;

  await evaluateWithBrowserMode(args, buildStartNavigateExpression(requestedUrl), timeoutMs, {
    awaitPromise: false,
  });

  if (args.waitForLoad === false) {
    return { url: requestedUrl };
  }

  return waitForNavigationResult(args, requestedUrl, timeoutMs);
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'browser_evaluate': {
        const evalResult = await cdpClient.evaluate({
          agentId: args.agentId,
          browserMode: args.browserMode,
          expression: args.expression,
          awaitPromise: args.awaitPromise,
          budget: { timeoutMs: args.timeoutMs },
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(evalResult, null, 2),
            },
          ],
        };
      }

      case 'browser_navigate': {
        const state = await navigateWithBrowserMode(args);
        return {
          content: [
            {
              type: 'text',
              text: `Navigated to ${state.url || args.url}`,
            },
          ],
        };
      }

      case 'browser_click': {
        await evaluateWithBrowserMode(args, buildClickExpression(args.selector), 10000);
        return {
          content: [{ type: 'text', text: `Clicked element: ${args.selector}` }],
        };
      }

      case 'browser_fill': {
        await evaluateWithBrowserMode(args, buildFillExpression(args.selector, args.value), 10000);
        return {
          content: [{ type: 'text', text: `Filled ${args.selector} with ${JSON.stringify(args.value)}` }],
        };
      }

      case 'browser_snapshot': {
        const snapshot = await evaluateWithBrowserMode(
          args,
          buildSnapshotExpression(args.includeHtml, args.includeCookies),
          15000
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(snapshot.result, null, 2),
            },
          ],
        };
      }

      case 'browser_extract': {
        const extracted = await evaluateWithBrowserMode(
          args,
          buildExtractExpression(args.selectors),
          10000
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(extracted.result, null, 2),
            },
          ],
        };
      }

      case 'browser_wait': {
        await evaluateWithBrowserMode(
          args,
          buildWaitExpression(args),
          (args.timeoutMs || 30000) + 1000
        );
        return {
          content: [{ type: 'text', text: 'Wait condition met' }],
        };
      }

      case 'browser_health': {
        const health = await cdpClient.getHealth();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(health, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('OpenClaw Browser MCP Server running on stdio');
  console.error('CDP Service URL:', process.env.CDP_SERVICE_URL || 'http://localhost:3100');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
