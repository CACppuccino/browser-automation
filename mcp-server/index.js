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
        stateMode: params.stateMode,
        profileId: params.profileId,
        profileScope: params.profileScope,
        workspacePath: params.workspacePath,
        freshInstanceId: params.freshInstanceId,
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

  async createProfile(params) {
    const response = await fetch(`${this.serviceUrl}/api/v1/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`CDP Service error: ${error.message || error.error || response.statusText}`);
    }

    return response.json();
  }

  async listProfiles(params = {}) {
    const query = new URLSearchParams();
    if (params.scope) query.set('scope', params.scope);
    if (params.workspacePath) query.set('workspacePath', params.workspacePath);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await fetch(`${this.serviceUrl}/api/v1/profiles${suffix}`, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`CDP Service error: ${error.message || error.error || response.statusText}`);
    }

    return response.json();
  }

  async getProfile(params) {
    const query = new URLSearchParams();
    if (params.scope) query.set('scope', params.scope);
    if (params.workspacePath) query.set('workspacePath', params.workspacePath);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await fetch(`${this.serviceUrl}/api/v1/profiles/${encodeURIComponent(params.profileId)}${suffix}`, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`CDP Service error: ${error.message || error.error || response.statusText}`);
    }

    return response.json();
  }

  async deleteProfile(params) {
    const query = new URLSearchParams();
    if (params.scope) query.set('scope', params.scope);
    if (params.workspacePath) query.set('workspacePath', params.workspacePath);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await fetch(`${this.serviceUrl}/api/v1/profiles/${encodeURIComponent(params.profileId)}${suffix}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`CDP Service error: ${error.message || error.error || response.statusText}`);
    }

    return { deleted: true };
  }

  async migrateProfile(params) {
    const query = new URLSearchParams();
    if (params.scope) query.set('scope', params.scope);
    if (params.workspacePath) query.set('workspacePath', params.workspacePath);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await fetch(`${this.serviceUrl}/api/v1/profiles/${encodeURIComponent(params.profileId)}/migrate${suffix}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({
        targetProfileId: params.targetProfileId,
        targetScope: params.targetScope,
        targetWorkspacePath: params.targetWorkspacePath,
        mode: params.mode,
        force: params.force,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`CDP Service error: ${error.message || error.error || response.statusText}`);
    }

    return response.json();
  }
}

const cdpClient = new CdpServiceClient({
  serviceUrl: process.env.CDP_SERVICE_URL || 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN,
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

const stateModeProperty = {
  type: 'string',
  enum: ['profile', 'fresh'],
  description: 'Browser state mode: persistent profile or fresh temporary instance',
};

const profileScopeProperty = {
  type: 'string',
  enum: ['workspace', 'global'],
  description: 'Profile storage scope: workspace-local or global shared storage',
};

const browserAccessProperties = {
  agentId: {
    type: 'string',
    description: "Optional agent identifier (default: 'mcp-agent')",
  },
  browserMode: browserModeProperty,
  stateMode: stateModeProperty,
  profileId: {
    type: 'string',
    description: 'Persistent profile identifier to use when stateMode=profile',
  },
  profileScope: profileScopeProperty,
  workspacePath: {
    type: 'string',
    description: 'Absolute workspace path used for workspace-scoped profiles',
  },
  freshInstanceId: {
    type: 'string',
    description: 'Optional explicit identifier for reusing a fresh instance within a task',
  },
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
        ...browserAccessProperties,
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
        ...browserAccessProperties,
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
        ...browserAccessProperties,
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
        ...browserAccessProperties,
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Get page snapshot. Returns DOM outline by default (safe for LLM context). Use expandSelector to get specific content with pagination support.',
    inputSchema: {
      type: 'object',
      properties: {
        // Content control
        expandSelector: {
          type: 'string',
          description:
            'CSS selector to expand and return HTML content (e.g., "main", ".post"). Without this, returns outline only.',
        },
        fullContent: {
          type: 'boolean',
          description: 'Return full body HTML instead of outline (default: false, use with caution)',
        },

        // Pagination / windowing
        offset: {
          type: 'number',
          description: 'Start line number for content window, 0-indexed (default: 0)',
        },
        limit: {
          type: 'number',
          description: 'Max lines to return (default: 150, max: 500)',
        },

        // Content filtering (all default to false for clean output)
        includeHead: {
          type: 'boolean',
          description: 'Include <head> content (default: false)',
        },
        includeScripts: {
          type: 'boolean',
          description: 'Include <script> tags (default: false)',
        },
        includeStyles: {
          type: 'boolean',
          description: 'Include <style> tags and inline styles (default: false)',
        },
        includeHidden: {
          type: 'boolean',
          description: 'Include hidden elements (default: false)',
        },
        includeSvg: {
          type: 'boolean',
          description: 'Include full SVG content (default: false, shows [SVG] placeholder)',
        },

        // Outline control
        outlineDepth: {
          type: 'number',
          description: 'Max depth for DOM outline (default: 4)',
        },

        // Other
        includeCookies: {
          type: 'boolean',
          description: 'Include cookies in response (default: false)',
        },
        ...browserAccessProperties,
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
        ...browserAccessProperties,
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
        ...browserAccessProperties,
      },
    },
  },
  {
    name: 'browser_profile_create',
    description: 'Create a persistent browser profile',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: 'Profile identifier to create',
        },
        scope: profileScopeProperty,
        workspacePath: {
          type: 'string',
          description: 'Absolute workspace path for workspace-scoped profiles',
        },
        displayName: {
          type: 'string',
          description: 'Optional human-friendly display name',
        },
      },
      required: ['profileId'],
    },
  },
  {
    name: 'browser_profile_list',
    description: 'List browser profiles',
    inputSchema: {
      type: 'object',
      properties: {
        scope: profileScopeProperty,
        workspacePath: {
          type: 'string',
          description: 'Absolute workspace path for workspace-scoped profiles',
        },
      },
    },
  },
  {
    name: 'browser_profile_get',
    description: 'Get a browser profile',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: 'Profile identifier to fetch',
        },
        scope: profileScopeProperty,
        workspacePath: {
          type: 'string',
          description: 'Absolute workspace path for workspace-scoped profiles',
        },
      },
      required: ['profileId'],
    },
  },
  {
    name: 'browser_profile_delete',
    description: 'Delete a browser profile',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: 'Profile identifier to delete',
        },
        scope: profileScopeProperty,
        workspacePath: {
          type: 'string',
          description: 'Absolute workspace path for workspace-scoped profiles',
        },
      },
      required: ['profileId'],
    },
  },
  {
    name: 'browser_profile_migrate',
    description: 'Migrate or copy a browser profile between workspace/global scopes',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: 'Source profile identifier',
        },
        scope: profileScopeProperty,
        workspacePath: {
          type: 'string',
          description: 'Absolute workspace path for source workspace-scoped profiles',
        },
        targetProfileId: {
          type: 'string',
          description: 'Optional destination profile identifier; defaults to source profileId',
        },
        targetScope: profileScopeProperty,
        targetWorkspacePath: {
          type: 'string',
          description: 'Absolute workspace path for destination workspace-scoped profiles',
        },
        mode: {
          type: 'string',
          enum: ['copy', 'move'],
          description: 'Whether to copy or move the source profile',
        },
        force: {
          type: 'boolean',
          description: 'Allow migrating even if the source profile is currently locked',
        },
      },
      required: ['profileId', 'targetScope'],
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

/**
 * Build expression to generate DOM outline (structural summary)
 */
function buildOutlineExpression(options = {}) {
  const maxDepth = options.outlineDepth || 4;
  const maxChildren = 15;
  const maxClassesShown = 3;

  return `
    (() => {
      const maxDepth = ${maxDepth};
      const maxChildren = ${maxChildren};
      const maxClassesShown = ${maxClassesShown};

      function estimateTokens(text) {
        if (!text) return 0;
        const cjk = (text.match(/[\\u4e00-\\u9fff\\u3040-\\u309f\\u30a0-\\u30ff\\uac00-\\ud7af]/g) || []).length;
        const other = text.length - cjk;
        return Math.ceil(cjk / 1.5 + other / 4);
      }

      function getElementHint(el) {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const ariaLabel = el.getAttribute('aria-label');
        const type = el.getAttribute('type');

        if (ariaLabel) return ariaLabel.slice(0, 30);
        if (role) return role;
        if (tag === 'input' && type) return 'input:' + type;
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'img') return 'image';
        if (tag === 'nav') return 'navigation';
        if (tag === 'header') return 'header';
        if (tag === 'footer') return 'footer';
        if (tag === 'main') return 'main content';
        if (tag === 'aside') return 'sidebar';
        if (tag === 'article') return 'article';
        if (tag === 'section') return 'section';
        if (tag === 'form') return 'form';
        return null;
      }

      function outlineNode(node, depth) {
        if (!node || node.nodeType !== 1) return null;

        const tag = node.tagName.toLowerCase();

        // Skip script, style, noscript, template
        if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) {
          return { tag, skipped: true };
        }

        const text = node.innerText || '';
        const textLen = text.length;
        const tokens = estimateTokens(text);
        const childCount = node.children.length;

        const result = {
          tag,
        };

        if (node.id) result.id = node.id;

        const classes = [...node.classList].slice(0, maxClassesShown);
        if (classes.length > 0) result.classes = classes;
        if (node.classList.length > maxClassesShown) {
          result.moreClasses = node.classList.length - maxClassesShown;
        }

        const hint = getElementHint(node);
        if (hint) result.hint = hint;

        result.stats = { textLen, tokens, children: childCount };

        // Recurse into children
        if (depth < maxDepth && childCount > 0) {
          const childOutlines = [];
          const visibleChildren = [...node.children].filter(c => {
            const t = c.tagName.toLowerCase();
            return !['script', 'style', 'noscript', 'template'].includes(t);
          });

          for (let i = 0; i < Math.min(visibleChildren.length, maxChildren); i++) {
            const co = outlineNode(visibleChildren[i], depth + 1);
            if (co && !co.skipped) childOutlines.push(co);
          }

          if (childOutlines.length > 0) {
            result.children = childOutlines;
          }

          if (visibleChildren.length > maxChildren) {
            result.moreChildren = visibleChildren.length - maxChildren;
          }
        } else if (childCount > 0) {
          result.expandable = childCount + ' children (increase outlineDepth or use expandSelector)';
        }

        return result;
      }

      const body = document.body;
      const outline = outlineNode(body, 0);

      // Calculate page-level stats
      const allText = body.innerText || '';
      const totalElements = body.querySelectorAll('*').length;
      const totalTokens = estimateTokens(allText);

      // Estimate line count if content were formatted
      const htmlLen = body.outerHTML.length;
      const estimatedLines = Math.ceil(htmlLen / 80);

      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        outline,
        pageStats: {
          totalElements,
          totalTextLength: allText.length,
          estimatedTokens: totalTokens,
          estimatedLines,
          hint: totalTokens > 10000
            ? 'Large page (' + totalTokens + ' tokens). Use expandSelector with offset/limit to browse content safely.'
            : null
        }
      };
    })()
  `;
}

/**
 * Build expression to extract and clean HTML content
 */
function buildContentExpression(options = {}) {
  const selector = options.expandSelector || 'body';
  const includeScripts = options.includeScripts || false;
  const includeStyles = options.includeStyles || false;
  const includeHidden = options.includeHidden || false;
  const includeSvg = options.includeSvg || false;
  const includeHead = options.includeHead || false;

  return `
    (() => {
      const selector = ${literal(selector)};
      const includeScripts = ${includeScripts};
      const includeStyles = ${includeStyles};
      const includeHidden = ${includeHidden};
      const includeSvg = ${includeSvg};
      const includeHead = ${includeHead};

      const targetEl = document.querySelector(selector);
      if (!targetEl) {
        throw new Error('Selector not found: ' + selector);
      }

      // Clone to avoid mutating the actual DOM
      const clone = targetEl.cloneNode(true);

      // Remove scripts
      if (!includeScripts) {
        clone.querySelectorAll('script, noscript').forEach(el => el.remove());
      }

      // Remove styles
      if (!includeStyles) {
        clone.querySelectorAll('style, link[rel="stylesheet"]').forEach(el => el.remove());
        clone.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));
      }

      // Remove hidden elements
      if (!includeHidden) {
        clone.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(el => el.remove());
      }

      // Replace SVG with placeholder
      if (!includeSvg) {
        clone.querySelectorAll('svg').forEach(svg => {
          const span = document.createElement('span');
          span.textContent = '[SVG]';
          svg.replaceWith(span);
        });
      }

      // Remove common noise attributes
      clone.querySelectorAll('*').forEach(el => {
        // Remove data-* attributes except useful ones
        [...el.attributes]
          .filter(a => a.name.startsWith('data-') &&
            !['data-id', 'data-testid', 'data-name', 'data-value'].includes(a.name))
          .forEach(a => el.removeAttribute(a.name));

        // Remove tracking/analytics attributes
        ['onclick', 'onload', 'onerror', 'onmouseover'].forEach(attr => {
          el.removeAttribute(attr);
        });
      });

      // Simple HTML formatting
      function formatHtml(html) {
        let formatted = '';
        let indent = 0;
        const lines = html
          .replace(/></g, '>\\n<')
          .replace(/([^>])\\n/g, '$1')
          .split('\\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Decrease indent for closing tags
          if (trimmed.startsWith('</')) {
            indent = Math.max(0, indent - 1);
          }

          formatted += '  '.repeat(indent) + trimmed + '\\n';

          // Increase indent for opening tags (not self-closing, not closing)
          if (trimmed.startsWith('<') &&
              !trimmed.startsWith('</') &&
              !trimmed.endsWith('/>') &&
              !trimmed.includes('</')) {
            indent++;
          }
        }
        return formatted;
      }

      const rawHtml = clone.outerHTML;
      const formattedHtml = formatHtml(rawHtml);
      const lines = formattedHtml.split('\\n').filter(l => l.trim());

      // Estimate tokens
      const text = clone.innerText || '';
      const cjk = (text.match(/[\\u4e00-\\u9fff]/g) || []).length;
      const tokens = Math.ceil(cjk / 1.5 + (text.length - cjk) / 4);

      return {
        url: location.href,
        title: document.title,
        selector,
        lines,
        totalLines: lines.length,
        estimatedTokens: tokens
      };
    })()
  `;
}

/**
 * Apply windowing (pagination) to content lines
 */
function applyWindowing(lines, offset = 0, limit = 150) {
  const totalLines = lines.length;
  const safeOffset = Math.max(0, Math.min(offset, totalLines));
  const safeLimit = Math.min(Math.max(1, limit), 500);

  const windowLines = lines.slice(safeOffset, safeOffset + safeLimit);

  // Add line numbers
  const numberedContent = windowLines
    .map((line, i) => `${String(safeOffset + i + 1).padStart(5)}: ${line}`)
    .join('\n');

  const returnedLines = windowLines.length;
  const hasMore = safeOffset + returnedLines < totalLines;
  const hasPrev = safeOffset > 0;

  return {
    content: numberedContent,
    window: {
      offset: safeOffset,
      limit: safeLimit,
      returnedLines,
      totalLines,
      hasMore,
      hasPrev,
      ...(hasMore ? { nextOffset: safeOffset + safeLimit } : {}),
      ...(hasPrev ? { prevOffset: Math.max(0, safeOffset - safeLimit) } : {}),
    },
  };
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
    stateMode: args.stateMode,
    profileId: args.profileId,
    profileScope: args.profileScope,
    workspacePath: args.workspacePath,
    freshInstanceId: args.freshInstanceId,
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

/**
 * Handle browser_snapshot with outline-first approach and windowing
 */
async function handleBrowserSnapshot(args) {
  const wantsContent = args.expandSelector || args.fullContent;

  if (!wantsContent) {
    // Return outline (safe default)
    const result = await evaluateWithBrowserMode(args, buildOutlineExpression(args), 15000);

    const response = result.result;

    // Add cookies if requested
    if (args.includeCookies) {
      const cookieResult = await evaluateWithBrowserMode(args, 'document.cookie', 5000);
      response.cookies = cookieResult.result;
    }

    return response;
  }

  // Content mode: extract, clean, and window
  const contentOpts = {
    expandSelector: args.expandSelector || 'body',
    includeScripts: args.includeScripts,
    includeStyles: args.includeStyles,
    includeHidden: args.includeHidden,
    includeSvg: args.includeSvg,
    includeHead: args.includeHead,
  };

  const result = await evaluateWithBrowserMode(args, buildContentExpression(contentOpts), 20000);

  const { lines, totalLines, estimatedTokens, url, title, selector } = result.result;

  // Apply windowing
  const offset = args.offset || 0;
  const limit = args.limit || 150;
  const windowed = applyWindowing(lines, offset, limit);

  const response = {
    url,
    title,
    selector,
    content: windowed.content,
    window: windowed.window,
    contentStats: {
      estimatedTokens,
      estimatedTokensInWindow: Math.ceil(
        (estimatedTokens * windowed.window.returnedLines) / Math.max(1, totalLines)
      ),
    },
  };

  // Add cookies if requested
  if (args.includeCookies) {
    const cookieResult = await evaluateWithBrowserMode(args, 'document.cookie', 5000);
    response.cookies = cookieResult.result;
  }

  return response;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'browser_evaluate': {
        const evalResult = await cdpClient.evaluate({
          agentId: args.agentId,
          browserMode: args.browserMode,
          stateMode: args.stateMode,
          profileId: args.profileId,
          profileScope: args.profileScope,
          workspacePath: args.workspacePath,
          freshInstanceId: args.freshInstanceId,
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
        const snapshot = await handleBrowserSnapshot(args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(snapshot, null, 2),
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

      case 'browser_profile_create': {
        const profile = await cdpClient.createProfile({
          profileId: args.profileId,
          scope: args.scope,
          workspacePath: args.workspacePath,
          displayName: args.displayName,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }],
        };
      }

      case 'browser_profile_list': {
        const profiles = await cdpClient.listProfiles({
          scope: args.scope,
          workspacePath: args.workspacePath,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(profiles, null, 2) }],
        };
      }

      case 'browser_profile_get': {
        const profile = await cdpClient.getProfile({
          profileId: args.profileId,
          scope: args.scope,
          workspacePath: args.workspacePath,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }],
        };
      }

      case 'browser_profile_delete': {
        const result = await cdpClient.deleteProfile({
          profileId: args.profileId,
          scope: args.scope,
          workspacePath: args.workspacePath,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'browser_profile_migrate': {
        const result = await cdpClient.migrateProfile({
          profileId: args.profileId,
          scope: args.scope,
          workspacePath: args.workspacePath,
          targetProfileId: args.targetProfileId,
          targetScope: args.targetScope,
          targetWorkspacePath: args.targetWorkspacePath,
          mode: args.mode,
          force: args.force,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
